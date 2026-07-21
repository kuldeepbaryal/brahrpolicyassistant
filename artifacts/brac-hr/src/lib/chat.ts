/**
 * Chat orchestration — the "answer a question" flow behind one interface.
 *
 * Given a user, conversation, and question it: applies the hourly rate limit,
 * consults the first-turn answer cache, queries the knowledge base through an
 * injected port, persists messages / engine session / stats / no-result
 * flags, and yields the answer as a stream of events the route encodes as
 * SSE. The knowledge base is a true external dependency, so it is a port:
 * production wraps Bedrock (discovery.ts); tests inject a mock.
 */
import { getChatStore, getInsightsStore, type ChatStore, type InsightsStore } from "./db";
import { answerQuery, createEngineSession, QuotaError } from "./discovery";
import { checkRateLimit } from "./ratelimit";
import { questionHash } from "./cache";
import { hashUser, log } from "./logger";
import type { AnswerResult, ChatMessage, Citation } from "./types";

export const NO_RESULTS_MESSAGE =
  "I couldn't find this in BRAC's HR policies. For help with this question, please contact **hrhelpdesk@brac.net**.";
export const QUOTA_MESSAGE =
  "We're seeing unusually high traffic right now and couldn't process your question. Please try again in a minute.";
export const ERROR_MESSAGE =
  "Something went wrong while looking that up. Please try again — if it keeps happening, contact **hrhelpdesk@brac.net**.";

export const MAX_QUESTION_LENGTH = 2000;

/** Port for the retrieval+generation engine (production: Bedrock KB). */
export interface KnowledgeBasePort {
  /** May return null when the engine creates sessions lazily on first answer. */
  createSession(userPseudoId: string): Promise<string | null>;
  answer(question: string, opts: { sessionName?: string | null; userPseudoId: string }): Promise<AnswerResult>;
}

/** Production adapter over the Bedrock KB client. */
export const bedrockKnowledgeBase: KnowledgeBasePort = {
  createSession: (userPseudoId) => createEngineSession(userPseudoId),
  answer: (question, opts) => answerQuery(question, opts),
};

export type ChatEvent =
  | { event: "meta"; data: { userMessageId: string; assistantMessageId: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "sources"; data: { citations: Citation[]; relatedQuestions: string[] } }
  | { event: "done"; data: { remaining: number } }
  | { event: "error"; data: { message: string } };

export type StartChatResult =
  /** Stream of events to forward to the client. */
  | { ok: true; events: AsyncGenerator<ChatEvent> }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "rate_limited"; limit: number };

export interface ChatDeps {
  chat?: ChatStore;
  insights?: InsightsStore;
  kb?: KnowledgeBasePort;
  /** Injected pacing delay so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start answering a question inside a conversation.
 *
 * Pre-stream failures (unknown conversation, rate limit) are returned as
 * values so the route can reply with a proper HTTP status. Once the event
 * stream starts, failures surface as an `error` event — never a throw.
 */
export async function startChat(
  user: { sub: string },
  conversationId: string,
  question: string,
  deps: ChatDeps = {}
): Promise<StartChatResult> {
  const db = deps.chat ?? getChatStore();
  const stats = deps.insights ?? getInsightsStore();
  const kb = deps.kb ?? bedrockKnowledgeBase;
  const sleep = deps.sleep ?? defaultSleep;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());

  const conversation = await db.getConversation(user.sub, conversationId);
  if (!conversation) return { ok: false, error: "not_found" };

  const rate = await checkRateLimit(db, user.sub);
  if (!rate.allowed) {
    log.warn("rate limited", { user: hashUser(user.sub) });
    return { ok: false, error: "rate_limited", limit: rate.limit };
  }

  const userPseudoId = hashUser(user.sub);
  const priorMessages = await db.listMessages(user.sub, conversationId);
  const isFirstTurn = priorMessages.length === 0;
  const started = now();

  async function* events(): AsyncGenerator<ChatEvent> {
    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      content: question,
      createdAt: now(),
    };
    const assistantId = newId();
    yield { event: "meta", data: { userMessageId: userMsg.id, assistantMessageId: assistantId } };

    try {
      // Only first turns are cache-eligible: follow-ups depend on session context.
      const qHash = questionHash(question);
      let result: AnswerResult | null = null;
      if (isFirstTurn) {
        result = await db.getCachedAnswer(qHash);
        if (result) result = { ...result, fromCache: true };
      }

      if (!result) {
        let engineSession = conversation!.engineSessionName;
        if (!engineSession) {
          engineSession = await kb.createSession(userPseudoId);
          if (engineSession) await db.setEngineSession(user.sub, conversationId, engineSession);
        }
        result = await kb.answer(question, { sessionName: engineSession, userPseudoId });
        if (result.sessionName && result.sessionName !== engineSession) {
          await db.setEngineSession(user.sub, conversationId, result.sessionName);
        }
        if (isFirstTurn && !result.noResults) {
          await db.setCachedAnswer(qHash, { ...result, sessionName: null });
        }
      }

      const answerText = result.noResults ? NO_RESULTS_MESSAGE : result.answerText;
      const citations = result.noResults ? [] : result.citations;

      // Stream the answer in small chunks so the UI always feels alive,
      // even though the Answer API returns the full text in one response.
      const words = answerText.split(/(?<=\s)/);
      const chunkSize = Math.max(2, Math.ceil(words.length / 80));
      for (let i = 0; i < words.length; i += chunkSize) {
        yield { event: "delta", data: { text: words.slice(i, i + chunkSize).join("") } };
        await sleep(result.fromCache ? 4 : 12);
      }

      yield { event: "sources", data: { citations, relatedQuestions: result.relatedQuestions } };

      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: answerText,
        citations,
        relatedQuestions: result.relatedQuestions,
        createdAt: now(),
        feedback: null,
        ...(result.noResults ? { noResults: true } : {}),
      };
      await db.addMessage(user.sub, conversationId, userMsg);
      await db.addMessage(user.sub, conversationId, assistantMsg);
      // Pre-aggregated dashboard stats — never let a stats failure break chat.
      try {
        await stats.recordQuestionAsked(question, userMsg.createdAt);
        if (result.noResults) await stats.recordNoResult(question, assistantMsg.createdAt);
      } catch (statErr) {
        log.error("stats write failed", {
          errorClass: "stats_write",
          detail: statErr instanceof Error ? statErr.message : String(statErr),
        });
      }
      if (isFirstTurn) {
        await db.renameConversation(user.sub, conversationId, question.slice(0, 60));
      } else {
        await db.touchConversation(user.sub, conversationId);
      }

      log.info("chat answered", {
        user: userPseudoId,
        latencyMs: now() - started,
        cached: !!result.fromCache,
        noResults: result.noResults,
        citations: citations.length,
      });
      yield { event: "done", data: { remaining: rate.remaining } };
    } catch (err) {
      const friendly = err instanceof QuotaError ? QUOTA_MESSAGE : ERROR_MESSAGE;
      log.error("chat failed", {
        user: userPseudoId,
        errorClass: err instanceof QuotaError ? "quota" : "api_error",
        latencyMs: now() - started,
      });
      yield { event: "error", data: { message: friendly } };
    }
  }

  return { ok: true, events: events() };
}
