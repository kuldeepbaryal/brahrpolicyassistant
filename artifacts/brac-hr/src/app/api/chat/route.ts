import { NextRequest } from "next/server";
import { SESSION_COOKIE, requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { MAX_QUESTION_LENGTH, startChat } from "@/lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * POST /api/chat — ask a question inside a conversation; the answer streams
 * back over SSE (`meta`, `delta`, `sources`, `done`, `error` events).
 * All orchestration lives in the chat module — this route only translates
 * HTTP/SSE.
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
  if (!question || !conversationId || question.length > MAX_QUESTION_LENGTH) {
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
  }

  const result = await startChat(user, conversationId, question);
  if (!result.ok) {
    if (result.error === "not_found") {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        error: "rate_limited",
        message: `You've reached the limit of ${result.limit} questions per hour. Please try again later.`,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const e of result.events) {
          controller.enqueue(encoder.encode(sse(e.event, e.data)));
        }
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
