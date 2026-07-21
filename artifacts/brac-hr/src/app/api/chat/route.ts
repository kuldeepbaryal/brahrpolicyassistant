import { NextRequest } from "next/server";
import { SESSION_COOKIE, requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getChatStore, getInsightsStore } from "@/lib/db";
import { answerQuery, createEngineSession, QuotaError } from "@/lib/discovery";
import { checkRateLimit } from "@/lib/ratelimit";
import { questionHash } from "@/lib/cache";
import { hashUser, log } from "@/lib/logger";
import type { AnswerResult, ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_RESULTS_MESSAGE =
  "I couldn't find this in BRAC's HR policies. For help with this question, please contact **hrhelpdesk@brac.net**.";
const QUOTA_MESSAGE =
  "We're seeing unusually high traffic right now and couldn't process your question. Please try again in a minute.";
const ERROR_MESSAGE =
  "Something went wrong while looking that up. Please try again — if it keeps happening, contact **hrhelpdesk@brac.net**.";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * POST /api/chat — ask a question inside a conversation; the answer streams
 * back over SSE (`meta`, `delta`, `sources`, `done`, `error` events).
 */
export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }
  let user;
  try {
    user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { conversationId?: string; question?: string };
  const question = body.question?.trim();
  const conversationId = body.conversationId;
  if (!question || !conversationId || question.length > 2000) {
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
  }

  const db = getChatStore();
  const conversation = await db.getConversation(user.sub, conversationId);
  if (!conversation) {
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }

  const rate = await checkRateLimit(db, user.sub);
  if (!rate.allowed) {
    log.warn("rate limited", { user: hashUser(user.sub) });
    return new Response(
      JSON.stringify({ error: "rate_limited", message: `You've reached the limit of ${rate.limit} questions per hour. Please try again later.` }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  const userPseudoId = hashUser(user.sub);
  const priorMessages = await db.listMessages(user.sub, conversationId);
  const isFirstTurn = priorMessages.length === 0;
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)));

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: question,
        createdAt: Date.now(),
      };
      const assistantId = crypto.randomUUID();
      send("meta", { userMessageId: userMsg.id, assistantMessageId: assistantId });

      try {
        // Only first turns are cache-eligible: follow-ups depend on session context.
        const qHash = questionHash(question);
        let result: AnswerResult | null = null;
        if (isFirstTurn) {
          result = await db.getCachedAnswer(qHash);
          if (result) result = { ...result, fromCache: true };
        }

        if (!result) {
          let engineSession = conversation.engineSessionName;
          if (!engineSession) {
            engineSession = await createEngineSession(userPseudoId);
            if (engineSession) await db.setEngineSession(user.sub, conversationId, engineSession);
          }
          result = await answerQuery(question, { sessionName: engineSession, userPseudoId });
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
          send("delta", { text: words.slice(i, i + chunkSize).join("") });
          await new Promise((r) => setTimeout(r, result.fromCache ? 4 : 12));
        }

        send("sources", { citations, relatedQuestions: result.relatedQuestions });

        const assistantMsg: ChatMessage = {
          id: assistantId,
          role: "assistant",
          content: answerText,
          citations,
          relatedQuestions: result.relatedQuestions,
          createdAt: Date.now(),
          feedback: null,
          ...(result.noResults ? { noResults: true } : {}),
        };
        await db.addMessage(user.sub, conversationId, userMsg);
        await db.addMessage(user.sub, conversationId, assistantMsg);
        // Pre-aggregated dashboard stats — never let a stats failure break chat.
        try {
          const stats = getInsightsStore();
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
          latencyMs: Date.now() - started,
          cached: !!result.fromCache,
          noResults: result.noResults,
          citations: citations.length,
        });
        send("done", { remaining: rate.remaining });
      } catch (err) {
        const friendly = err instanceof QuotaError ? QUOTA_MESSAGE : ERROR_MESSAGE;
        log.error("chat failed", {
          user: userPseudoId,
          errorClass: err instanceof QuotaError ? "quota" : "api_error",
          latencyMs: Date.now() - started,
        });
        send("error", { message: friendly });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
