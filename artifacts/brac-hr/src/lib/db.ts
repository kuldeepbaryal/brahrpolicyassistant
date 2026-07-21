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
  DeleteCommand,
  UpdateCommand,
  BatchWriteCommand,
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

export interface Db {
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

/* ─────────────────────── DynamoDB implementation ──────────────────────── */

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function makeDynamoClient() {
  const raw = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
  });
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

class DynamoDb implements Db {
  private client: DynamoDBDocumentClient;
  private T: {
    conversations: string;
    messages: string;
    feedback: string;
    cache: string;
    rateLimits: string;
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
    };
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
}

/* ─────────────────────── In-memory implementation (mock) ─────────────── */

export class MemoryDb implements Db {
  private conversations = new Map<string, Map<string, Conversation>>();
  private messages = new Map<string, ChatMessage[]>();
  private feedback: FeedbackEvent[] = [];
  private cache = new Map<string, { answer: AnswerResult; expiresAt: number }>();
  private counters = new Map<string, number>();

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
}

/* ──────────────────────────────── factory ────────────────────────────── */

const globalForDb = globalThis as unknown as { __bracHrDb?: Db };

export function getDb(): Db {
  if (!globalForDb.__bracHrDb) {
    globalForDb.__bracHrDb = isMockMode() ? new MemoryDb() : new DynamoDb();
  }
  return globalForDb.__bracHrDb;
}
