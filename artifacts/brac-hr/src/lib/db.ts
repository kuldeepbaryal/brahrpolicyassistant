/**
 * Data layer backed by Amazon DynamoDB.
 *
 * Table layout (all prefixed by DYNAMO_TABLE_PREFIX, default "BracHR"):
 *   BracHRConversations   PK: userId (S)      SK: conversationId (S)
 *   BracHRMessages        PK: convKey (S)      SK: messageId (S)
 *                           convKey = "userId#conversationId"
 *   BracHRFeedback        PK: feedbackId (S)
 *   BracHRAnswerCache     PK: questionHash (S)
 *   BracHRRateLimits      PK: windowKey (S)
 *   BracHRDailyStats      PK: day (S "YYYY-MM-DD" UTC)  SK: sk (S)
 *       sk = "totals"            → atomic counters (questions, noResults, thumbsUp, thumbsDown)
 *       sk = "q#<normalized q>"  → per-question counter + sample raw question
 *       sk = "e#<ts>#<id>"       → event record (type: no_result | thumbs_down)
 *     Written on every chat/feedback event so the admin dashboard reads a
 *     handful of small day partitions instead of scanning whole tables.
 *     IAM: the app role needs dynamodb:Query, UpdateItem, PutItem on it.
 *
 * In mock mode an in-memory store is used (dev only — disabled in production).
 *
 * AWS credentials are resolved automatically:
 *   • Amplify/Lambda  → execution role (no env vars needed)
 *   • Local dev       → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env.local
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  UpdateCommand,
  BatchWriteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { isMockMode, config } from "./config";
import type { AnswerResult, ChatMessage, Conversation } from "./types";

export interface FeedbackEvent {
  userEmail: string;
  conversationId: string;
  messageId: string;
  rating: "up" | "down";
  question: string;
  answer: string;
  citations: { title: string; uri: string }[];
  createdAt: number;
}

export interface RoleChangeEvent {
  actorSub: string;
  actorEmail: string;
  actorName: string;
  targetSub: string;
  targetEmail: string;
  targetName: string;
  fromRole: "admin" | "user";
  toRole: "admin" | "user";
  createdAt: number;
}

export interface UserRecord {
  sub: string;
  email: string;
  name: string;
  role: "admin" | "user";
  createdAt: number;
  lastSignInAt: number;
}

/* ───────────────────── Typed storage errors (the seam) ─────────────────
 * Adapters translate provider-specific failures into these codes so no
 * caller ever needs to know DynamoDB (or any provider) vocabulary. */

export type StorageErrorCode =
  /** The runtime identity lacks permission for the operation. */
  | "permission_denied"
  /** The backing table/resource does not exist yet. */
  | "not_provisioned"
  /** A conditional/atomic write lost its precondition (e.g. record missing). */
  | "conflict"
  /** Anything else — transient or unknown provider failure. */
  | "unavailable";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Store for user profiles, roles, and the role-change audit trail. */
export interface UserStore {
  /** Create-or-update the user profile on sign-in. Never overwrites an existing role. */
  upsertUser(user: { sub: string; email: string; name: string }, initialRole: "admin" | "user"): Promise<UserRecord>;
  getUser(sub: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  setUserRole(sub: string, role: "admin" | "user"): Promise<void>;
  /**
   * Atomically set a user's role AND append the audit event — either both
   * persist or neither does, so a successful response always has audit evidence.
   */
  changeUserRole(sub: string, role: "admin" | "user", audit: RoleChangeEvent): Promise<void>;
  /** Audit: role changes, newest first (bounded). */
  listRoleChanges(limit: number): Promise<RoleChangeEvent[]>;
}

/** Store for conversations, messages, feedback, the answer cache, and rate limits. */
export interface ChatStore {
  listConversations(sub: string): Promise<Conversation[]>;
  createConversation(sub: string, title: string): Promise<Conversation>;
  getConversation(sub: string, id: string): Promise<Conversation | null>;
  renameConversation(sub: string, id: string, title: string): Promise<void>;
  deleteConversation(sub: string, id: string): Promise<void>;
  setEngineSession(sub: string, id: string, engineSessionName: string): Promise<void>;
  touchConversation(sub: string, id: string): Promise<void>;

  listMessages(sub: string, convId: string): Promise<ChatMessage[]>;
  addMessage(sub: string, convId: string, msg: ChatMessage): Promise<void>;
  setMessageFeedback(sub: string, convId: string, messageId: string, rating: "up" | "down"): Promise<void>;

  saveFeedback(event: FeedbackEvent): Promise<void>;

  getCachedAnswer(questionHash: string): Promise<AnswerResult | null>;
  setCachedAnswer(questionHash: string, answer: AnswerResult): Promise<void>;

  incrementRateCounter(sub: string, windowKey: string): Promise<number>;
}

/** Store for admin dashboard data: usage stats and (legacy) scans. */
export interface InsightsStore {
  /** Admin: all messages across all users since a timestamp (table scan). */
  adminScanMessages(sinceMs: number): Promise<ScanResult<AdminMessage>>;
  /** Admin: all feedback events since a timestamp (table scan). */
  adminScanFeedback(sinceMs: number): Promise<ScanResult<FeedbackEvent>>;

  /** Stats: a user asked a question (increments daily + per-question counters). */
  recordQuestionAsked(question: string, at: number): Promise<void>;
  /** Stats: an answer came back with no results. */
  recordNoResult(question: string, at: number): Promise<void>;
  /** Stats: a thumbs up/down was given. */
  recordFeedbackStat(rating: "up" | "down", question: string, answer: string, at: number): Promise<void>;
  /** Admin: pre-aggregated insights read from daily stats partitions (bounded, exact). */
  getDailyInsights(sinceMs: number): Promise<DailyInsightsData>;
}

/** Full storage surface — one object implements all three slices. */
export interface Db extends UserStore, ChatStore, InsightsStore {}

export interface DailyInsightsData {
  totals: { questions: number; noResults: number; thumbsUp: number; thumbsDown: number };
  /** Per normalized question: sample raw text + exact count across the window. */
  questionCounts: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; createdAt: number }[];
}

/** Normalize a question for exact-duplicate counting (shared by stats + legacy path). */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** UTC day bucket, e.g. "2026-07-21". */
function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** All UTC day keys from sinceMs through today (inclusive). */
function dayKeysSince(sinceMs: number): string[] {
  const days: string[] = [];
  const DAY = 24 * 3600 * 1000;
  const end = Date.now();
  for (let t = sinceMs; ; t += DAY) {
    const k = dayKey(Math.min(t, end));
    if (days[days.length - 1] !== k) days.push(k);
    if (t >= end) break;
  }
  return days;
}

export interface ScanResult<T> {
  items: T[];
  /** True when the scan stopped early — aggregates are then a lower bound. */
  truncated: boolean;
}

export interface AdminMessage {
  convKey: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  noResults?: boolean;
  feedback?: "up" | "down" | null;
}

/* ─────────────────────── DynamoDB implementation ──────────────────────── */

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Map an AWS SDK failure to a provider-neutral StorageError. */
function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  if (/AccessDenied/i.test(name) || /AccessDenied/i.test(message)) {
    return new StorageError("permission_denied", message);
  }
  if (/ResourceNotFound/i.test(name) || /ResourceNotFound/i.test(message)) {
    return new StorageError("not_provisioned", message);
  }
  if (name === "ConditionalCheckFailedException") {
    return new StorageError("conflict", message);
  }
  if (name === "TransactionCanceledException") {
    // Prefer structured cancellation reasons over message text when available.
    const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })?.CancellationReasons;
    const conditional = reasons
      ? reasons.some((r) => r?.Code === "ConditionalCheckFailed")
      : /ConditionalCheckFailed/i.test(message);
    return new StorageError(conditional ? "conflict" : "unavailable", message);
  }
  return new StorageError("unavailable", message);
}

function makeDynamoClient() {
  const raw = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
  });
  const client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  // Translate every provider failure at the seam, so callers of any store
  // method only ever see StorageError codes — never DynamoDB vocabulary.
  const originalSend = client.send.bind(client);
  client.send = (async (...args: Parameters<typeof originalSend>) => {
    try {
      return await originalSend(...args);
    } catch (err) {
      throw toStorageError(err);
    }
  }) as typeof client.send;
  return client;
}

class DynamoDb implements Db {
  private client: DynamoDBDocumentClient;
  private T: {
    conversations: string;
    messages: string;
    feedback: string;
    cache: string;
    rateLimits: string;
    users: string;
    dailyStats: string;
  };

  constructor() {
    this.client = makeDynamoClient();
    const p = config.dynamoTablePrefix;
    this.T = {
      conversations: `${p}Conversations`,
      messages: `${p}Messages`,
      feedback: `${p}Feedback`,
      cache: `${p}AnswerCache`,
      rateLimits: `${p}RateLimits`,
      users: `${p}Users`,
      dailyStats: `${p}DailyStats`,
    };
  }

  async upsertUser(
    user: { sub: string; email: string; name: string },
    initialRole: "admin" | "user"
  ): Promise<UserRecord> {
    const now = Date.now();
    const res = await this.client.send(
      new UpdateCommand({
        TableName: this.T.users,
        Key: { sub: user.sub },
        // Role and createdAt only on first write — role is managed via setUserRole.
        UpdateExpression:
          "SET email = :e, #n = :n, lastSignInAt = :t, #r = if_not_exists(#r, :role), createdAt = if_not_exists(createdAt, :t)",
        ExpressionAttributeNames: { "#n": "name", "#r": "role" },
        ExpressionAttributeValues: { ":e": user.email, ":n": user.name, ":t": now, ":role": initialRole },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes as UserRecord;
  }

  async getUser(sub: string): Promise<UserRecord | null> {
    const res = await this.client.send(new GetCommand({ TableName: this.T.users, Key: { sub } }));
    return (res.Item as UserRecord) ?? null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const items: UserRecord[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new ScanCommand({ TableName: this.T.users, ExclusiveStartKey: lastKey })
      );
      items.push(...((res.Items ?? []) as UserRecord[]));
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey && items.length < 5000);
    return items.sort((a, b) => b.lastSignInAt - a.lastSignInAt);
  }

  async setUserRole(sub: string, role: "admin" | "user"): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.users,
        Key: { sub },
        ConditionExpression: "attribute_exists(#s)",
        UpdateExpression: "SET #r = :r",
        ExpressionAttributeNames: { "#r": "role", "#s": "sub" },
        ExpressionAttributeValues: { ":r": role },
      })
    );
  }

  // Stored in the DailyStats table under a fixed partition so no new table or
  // IAM change is needed (the app role already has Query/PutItem on it).
  private static AUDIT_PK = "audit#role-changes";

  async changeUserRole(sub: string, role: "admin" | "user", audit: RoleChangeEvent): Promise<void> {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.T.users,
              Key: { sub },
              ConditionExpression: "attribute_exists(#s)",
              UpdateExpression: "SET #r = :r",
              ExpressionAttributeNames: { "#r": "role", "#s": "sub" },
              ExpressionAttributeValues: { ":r": role },
            },
          },
          {
            Put: {
              TableName: this.T.dailyStats,
              Item: { day: DynamoDb.AUDIT_PK, sk: `rc#${audit.createdAt}#${newId()}`, ...audit },
            },
          },
        ],
      })
    );
  }

  async listRoleChanges(limit: number): Promise<RoleChangeEvent[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.T.dailyStats,
        KeyConditionExpression: "#d = :d",
        ExpressionAttributeNames: { "#d": "day" },
        ExpressionAttributeValues: { ":d": DynamoDb.AUDIT_PK },
        ScanIndexForward: false, // sk starts with the timestamp → newest first
        Limit: limit,
      })
    );
    return (res.Items ?? []) as RoleChangeEvent[];
  }

  async listConversations(sub: string): Promise<Conversation[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.T.conversations,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": sub },
      })
    );
    const items = (res.Items ?? []) as Array<Conversation & { userId: string }>;
    return items
      .map(({ userId: _u, ...rest }) => rest as Conversation)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100);
  }

  async createConversation(sub: string, title: string): Promise<Conversation> {
    const id = newId();
    const now = Date.now();
    const conv: Conversation = { id, title, createdAt: now, updatedAt: now, engineSessionName: null };
    await this.client.send(
      new PutCommand({ TableName: this.T.conversations, Item: { userId: sub, ...conv } })
    );
    return conv;
  }

  async getConversation(sub: string, id: string): Promise<Conversation | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.T.conversations, Key: { userId: sub, id } })
    );
    if (!res.Item) return null;
    const { userId: _u, ...rest } = res.Item as Conversation & { userId: string };
    return rest as Conversation;
  }

  async renameConversation(sub: string, id: string, title: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.conversations,
        Key: { userId: sub, id },
        UpdateExpression: "SET title = :t, updatedAt = :u",
        ExpressionAttributeValues: { ":t": title, ":u": Date.now() },
      })
    );
  }

  async deleteConversation(sub: string, id: string): Promise<void> {
    // Delete the conversation record
    await this.client.send(
      new DeleteCommand({ TableName: this.T.conversations, Key: { userId: sub, id } })
    );
    // Delete all messages — query then batch-delete in groups of 25
    const convKey = `${sub}#${id}`;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({
          TableName: this.T.messages,
          KeyConditionExpression: "convKey = :ck",
          ExpressionAttributeValues: { ":ck": convKey },
          ProjectionExpression: "messageId",
          ExclusiveStartKey: lastKey,
        })
      );
      const keys = (res.Items ?? []) as { messageId: string }[];
      for (let i = 0; i < keys.length; i += 25) {
        await this.client.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.T.messages]: keys.slice(i, i + 25).map((k) => ({
                DeleteRequest: { Key: { convKey, messageId: k.messageId } },
              })),
            },
          })
        );
      }
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }

  async setEngineSession(sub: string, id: string, engineSessionName: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.conversations,
        Key: { userId: sub, id },
        UpdateExpression: "SET engineSessionName = :s",
        ExpressionAttributeValues: { ":s": engineSessionName },
      })
    );
  }

  async touchConversation(sub: string, id: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.conversations,
        Key: { userId: sub, id },
        UpdateExpression: "SET updatedAt = :u",
        ExpressionAttributeValues: { ":u": Date.now() },
      })
    );
  }

  async listMessages(sub: string, convId: string): Promise<ChatMessage[]> {
    const convKey = `${sub}#${convId}`;
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.T.messages,
        KeyConditionExpression: "convKey = :ck",
        ExpressionAttributeValues: { ":ck": convKey },
        Limit: 500,
      })
    );
    const items = (res.Items ?? []) as Array<ChatMessage & { convKey: string; messageId: string }>;
    return items
      .map(({ convKey: _c, messageId: _m, ...rest }) => rest as ChatMessage)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async addMessage(sub: string, convId: string, msg: ChatMessage): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.T.messages,
        Item: { convKey: `${sub}#${convId}`, messageId: msg.id, ...msg },
      })
    );
  }

  async setMessageFeedback(
    sub: string,
    convId: string,
    messageId: string,
    rating: "up" | "down"
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.messages,
        Key: { convKey: `${sub}#${convId}`, messageId },
        UpdateExpression: "SET feedback = :r",
        ExpressionAttributeValues: { ":r": rating },
      })
    );
  }

  async saveFeedback(event: FeedbackEvent): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.T.feedback,
        Item: { feedbackId: newId(), ...event },
      })
    );
  }

  async getCachedAnswer(questionHash: string): Promise<AnswerResult | null> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.T.cache, Key: { questionHash } })
    );
    if (!res.Item) return null;
    const { answer, expiresAt } = res.Item as { answer: AnswerResult; expiresAt: number };
    if (expiresAt < Date.now()) return null;
    return answer;
  }

  async setCachedAnswer(questionHash: string, answer: AnswerResult): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.T.cache,
        Item: { questionHash, answer, expiresAt: Date.now() + config.answerCacheTtlSeconds * 1000 },
      })
    );
  }

  async incrementRateCounter(sub: string, windowKey: string): Promise<number> {
    const res = await this.client.send(
      new UpdateCommand({
        TableName: this.T.rateLimits,
        Key: { windowKey },
        UpdateExpression: "ADD #cnt :one SET #sub = :sub, updatedAt = :ts",
        ExpressionAttributeNames: { "#cnt": "count", "#sub": "sub" },
        ExpressionAttributeValues: { ":one": 1, ":sub": sub, ":ts": Date.now() },
        ReturnValues: "ALL_NEW",
      })
    );
    return (res.Attributes?.count as number) ?? 1;
  }

  private async scanAll<T>(
    tableName: string,
    sinceMs: number,
    projection: string,
    names?: Record<string, string>
  ): Promise<ScanResult<T>> {
    const MAX_ITEMS = 20000;
    const items: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await this.client.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "createdAt >= :s",
          ExpressionAttributeValues: { ":s": sinceMs },
          ProjectionExpression: projection,
          ...(names ? { ExpressionAttributeNames: names } : {}),
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...((res.Items ?? []) as T[]));
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey && items.length < MAX_ITEMS);
    // If we stopped while more pages remained, surface it — never silently
    // present partial aggregates as complete.
    return { items, truncated: !!lastKey && items.length >= MAX_ITEMS };
  }

  async adminScanMessages(sinceMs: number): Promise<ScanResult<AdminMessage>> {
    return this.scanAll<AdminMessage>(
      this.T.messages,
      sinceMs,
      "convKey, #r, content, createdAt, noResults, feedback",
      { "#r": "role" }
    );
  }

  async adminScanFeedback(sinceMs: number): Promise<ScanResult<FeedbackEvent>> {
    return this.scanAll<FeedbackEvent>(
      this.T.feedback,
      sinceMs,
      "conversationId, messageId, rating, question, answer, createdAt"
    );
  }

  /* ── Daily stats (pre-aggregated admin dashboard data) ── */

  private async bumpTotals(at: number, field: "questions" | "noResults" | "thumbsUp" | "thumbsDown"): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.T.dailyStats,
        Key: { day: dayKey(at), sk: "totals" },
        UpdateExpression: "ADD #f :one",
        ExpressionAttributeNames: { "#f": field },
        ExpressionAttributeValues: { ":one": 1 },
      })
    );
  }

  private async putStatEvent(at: number, event: Record<string, unknown>): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.T.dailyStats,
        Item: { day: dayKey(at), sk: `e#${at}#${newId()}`, createdAt: at, ...event },
      })
    );
  }

  async recordQuestionAsked(question: string, at: number): Promise<void> {
    const writes: Promise<unknown>[] = [this.bumpTotals(at, "questions")];
    const key = normalizeQuestion(question);
    if (key) {
      // SK length is bounded; extremely long questions share a truncated bucket.
      writes.push(
        this.client.send(
          new UpdateCommand({
            TableName: this.T.dailyStats,
            Key: { day: dayKey(at), sk: `q#${key.slice(0, 512)}` },
            UpdateExpression: "ADD #c :one SET question = if_not_exists(question, :q)",
            ExpressionAttributeNames: { "#c": "count" },
            ExpressionAttributeValues: { ":one": 1, ":q": question.slice(0, 2000) },
          })
        )
      );
    }
    await Promise.all(writes);
  }

  async recordNoResult(question: string, at: number): Promise<void> {
    await Promise.all([
      this.bumpTotals(at, "noResults"),
      this.putStatEvent(at, { type: "no_result", question: question.slice(0, 2000) }),
    ]);
  }

  async recordFeedbackStat(rating: "up" | "down", question: string, answer: string, at: number): Promise<void> {
    const writes: Promise<unknown>[] = [this.bumpTotals(at, rating === "up" ? "thumbsUp" : "thumbsDown")];
    if (rating === "down") {
      writes.push(
        this.putStatEvent(at, {
          type: "thumbs_down",
          question: question.slice(0, 2000),
          answer: answer.slice(0, 4000),
        })
      );
    }
    await Promise.all(writes);
  }

  async getDailyInsights(sinceMs: number): Promise<DailyInsightsData> {
    const days = dayKeysSince(sinceMs);
    const totals = { questions: 0, noResults: 0, thumbsUp: 0, thumbsDown: 0 };
    const qMap = new Map<string, { question: string; count: number }>();
    const noResultQuestions: { question: string; askedAt: number }[] = [];
    const thumbsDown: { question: string; answer: string; createdAt: number }[] = [];

    await Promise.all(
      days.map(async (day) => {
        let lastKey: Record<string, unknown> | undefined;
        do {
          const res = await this.client.send(
            new QueryCommand({
              TableName: this.T.dailyStats,
              KeyConditionExpression: "#d = :d",
              ExpressionAttributeNames: { "#d": "day" },
              ExpressionAttributeValues: { ":d": day },
              ExclusiveStartKey: lastKey,
            })
          );
          for (const raw of res.Items ?? []) {
            const item = raw as Record<string, unknown> & { sk: string };
            if (item.sk === "totals") {
              totals.questions += (item.questions as number) ?? 0;
              totals.noResults += (item.noResults as number) ?? 0;
              totals.thumbsUp += (item.thumbsUp as number) ?? 0;
              totals.thumbsDown += (item.thumbsDown as number) ?? 0;
            } else if (item.sk.startsWith("q#")) {
              const key = item.sk.slice(2);
              const entry = qMap.get(key) ?? { question: (item.question as string) ?? key, count: 0 };
              entry.count += (item.count as number) ?? 0;
              qMap.set(key, entry);
            } else if (item.sk.startsWith("e#")) {
              const createdAt = (item.createdAt as number) ?? 0;
              if (createdAt < sinceMs) continue; // same-day events before the window start
              if (item.type === "no_result") {
                noResultQuestions.push({ question: (item.question as string) ?? "", askedAt: createdAt });
              } else if (item.type === "thumbs_down") {
                thumbsDown.push({
                  question: (item.question as string) ?? "",
                  answer: (item.answer as string) ?? "",
                  createdAt,
                });
              }
            }
          }
          lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey);
      })
    );

    return {
      totals,
      questionCounts: [...qMap.values()],
      noResultQuestions,
      thumbsDown,
    };
  }
}

/* ─────────────────────── In-memory implementation (mock) ─────────────── */

export class MemoryDb implements Db {
  private users = new Map<string, UserRecord>();
  private conversations = new Map<string, Map<string, Conversation>>();

  async upsertUser(user: { sub: string; email: string; name: string }, initialRole: "admin" | "user") {
    const now = Date.now();
    const existing = this.users.get(user.sub);
    const rec: UserRecord = {
      sub: user.sub,
      email: user.email,
      name: user.name,
      role: existing?.role ?? initialRole,
      createdAt: existing?.createdAt ?? now,
      lastSignInAt: now,
    };
    this.users.set(user.sub, rec);
    return rec;
  }
  async getUser(sub: string) {
    return this.users.get(sub) ?? null;
  }
  async listUsers() {
    return [...this.users.values()].sort((a, b) => b.lastSignInAt - a.lastSignInAt);
  }
  async setUserRole(sub: string, role: "admin" | "user") {
    const u = this.users.get(sub);
    if (u) u.role = role;
  }

  private roleChanges: RoleChangeEvent[] = [];
  async changeUserRole(sub: string, role: "admin" | "user", audit: RoleChangeEvent) {
    const u = this.users.get(sub);
    if (!u) throw new StorageError("conflict", "user record does not exist");
    u.role = role;
    this.roleChanges.push(audit);
  }
  async listRoleChanges(limit: number) {
    return [...this.roleChanges].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  private messages = new Map<string, ChatMessage[]>();
  private feedback: FeedbackEvent[] = [];
  private cache = new Map<string, { answer: AnswerResult; expiresAt: number }>();
  private counters = new Map<string, number>();
  private statTotals = new Map<string, { questions: number; noResults: number; thumbsUp: number; thumbsDown: number }>();
  private statQuestions = new Map<string, Map<string, { question: string; count: number }>>();
  private statEvents: Array<{ type: "no_result" | "thumbs_down"; question: string; answer?: string; createdAt: number }> = [];

  private userConvs(sub: string) {
    if (!this.conversations.has(sub)) this.conversations.set(sub, new Map());
    return this.conversations.get(sub)!;
  }

  async listConversations(sub: string) {
    return [...this.userConvs(sub).values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async createConversation(sub: string, title: string) {
    const now = Date.now();
    const conv: Conversation = { id: newId(), title, createdAt: now, updatedAt: now, engineSessionName: null };
    this.userConvs(sub).set(conv.id, conv);
    return conv;
  }
  async getConversation(sub: string, id: string) {
    return this.userConvs(sub).get(id) ?? null;
  }
  async renameConversation(sub: string, id: string, title: string) {
    const c = this.userConvs(sub).get(id);
    if (c) Object.assign(c, { title, updatedAt: Date.now() });
  }
  async deleteConversation(sub: string, id: string) {
    this.userConvs(sub).delete(id);
    this.messages.delete(`${sub}/${id}`);
  }
  async setEngineSession(sub: string, id: string, engineSessionName: string) {
    const c = this.userConvs(sub).get(id);
    if (c) c.engineSessionName = engineSessionName;
  }
  async touchConversation(sub: string, id: string) {
    const c = this.userConvs(sub).get(id);
    if (c) c.updatedAt = Date.now();
  }
  async listMessages(sub: string, convId: string) {
    return this.messages.get(`${sub}/${convId}`) ?? [];
  }
  async addMessage(sub: string, convId: string, msg: ChatMessage) {
    const key = `${sub}/${convId}`;
    if (!this.messages.has(key)) this.messages.set(key, []);
    this.messages.get(key)!.push(msg);
  }
  async setMessageFeedback(sub: string, convId: string, messageId: string, rating: "up" | "down") {
    const msg = (this.messages.get(`${sub}/${convId}`) ?? []).find((m) => m.id === messageId);
    if (msg) msg.feedback = rating;
  }
  async saveFeedback(event: FeedbackEvent) {
    this.feedback.push(event);
  }
  async getCachedAnswer(questionHash: string) {
    const hit = this.cache.get(questionHash);
    if (!hit || hit.expiresAt < Date.now()) return null;
    return hit.answer;
  }
  async setCachedAnswer(questionHash: string, answer: AnswerResult) {
    this.cache.set(questionHash, { answer, expiresAt: Date.now() + config.answerCacheTtlSeconds * 1000 });
  }
  async incrementRateCounter(_sub: string, windowKey: string) {
    const next = (this.counters.get(windowKey) ?? 0) + 1;
    this.counters.set(windowKey, next);
    return next;
  }
  async adminScanMessages(sinceMs: number): Promise<ScanResult<AdminMessage>> {
    const out: AdminMessage[] = [];
    for (const [key, msgs] of this.messages) {
      for (const m of msgs) {
        if (m.createdAt >= sinceMs) {
          out.push({
            convKey: key,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            noResults: m.noResults,
            feedback: m.feedback,
          });
        }
      }
    }
    return { items: out, truncated: false };
  }
  async adminScanFeedback(sinceMs: number): Promise<ScanResult<FeedbackEvent>> {
    return { items: this.feedback.filter((f) => f.createdAt >= sinceMs), truncated: false };
  }

  private dayTotals(at: number) {
    const k = dayKey(at);
    if (!this.statTotals.has(k)) {
      this.statTotals.set(k, { questions: 0, noResults: 0, thumbsUp: 0, thumbsDown: 0 });
    }
    return this.statTotals.get(k)!;
  }
  async recordQuestionAsked(question: string, at: number) {
    this.dayTotals(at).questions++;
    const key = normalizeQuestion(question);
    if (!key) return;
    const day = dayKey(at);
    if (!this.statQuestions.has(day)) this.statQuestions.set(day, new Map());
    const m = this.statQuestions.get(day)!;
    const entry = m.get(key) ?? { question, count: 0 };
    entry.count++;
    m.set(key, entry);
  }
  async recordNoResult(question: string, at: number) {
    this.dayTotals(at).noResults++;
    this.statEvents.push({ type: "no_result", question, createdAt: at });
  }
  async recordFeedbackStat(rating: "up" | "down", question: string, answer: string, at: number) {
    if (rating === "up") this.dayTotals(at).thumbsUp++;
    else {
      this.dayTotals(at).thumbsDown++;
      this.statEvents.push({ type: "thumbs_down", question, answer, createdAt: at });
    }
  }
  async getDailyInsights(sinceMs: number): Promise<DailyInsightsData> {
    const days = new Set(dayKeysSince(sinceMs));
    const totals = { questions: 0, noResults: 0, thumbsUp: 0, thumbsDown: 0 };
    for (const [day, t] of this.statTotals) {
      if (!days.has(day)) continue;
      totals.questions += t.questions;
      totals.noResults += t.noResults;
      totals.thumbsUp += t.thumbsUp;
      totals.thumbsDown += t.thumbsDown;
    }
    const qMap = new Map<string, { question: string; count: number }>();
    for (const [day, m] of this.statQuestions) {
      if (!days.has(day)) continue;
      for (const [key, e] of m) {
        const entry = qMap.get(key) ?? { question: e.question, count: 0 };
        entry.count += e.count;
        qMap.set(key, entry);
      }
    }
    const events = this.statEvents.filter((e) => e.createdAt >= sinceMs);
    return {
      totals,
      questionCounts: [...qMap.values()],
      noResultQuestions: events
        .filter((e) => e.type === "no_result")
        .map((e) => ({ question: e.question, askedAt: e.createdAt })),
      thumbsDown: events
        .filter((e) => e.type === "thumbs_down")
        .map((e) => ({ question: e.question, answer: e.answer ?? "", createdAt: e.createdAt })),
    };
  }
}

/* ──────────────────────────────── factory ────────────────────────────── */

const globalForDb = globalThis as unknown as { __bracHrDb?: Db };

export function getDb(): Db {
  if (!globalForDb.__bracHrDb) {
    globalForDb.__bracHrDb = isMockMode() ? new MemoryDb() : new DynamoDb();
  }
  return globalForDb.__bracHrDb;
}

/* Narrow accessors — callers depend only on the slice they actually use. */

export function getUserStore(): UserStore {
  return getDb();
}

export function getChatStore(): ChatStore {
  return getDb();
}

export function getInsightsStore(): InsightsStore {
  return getDb();
}
