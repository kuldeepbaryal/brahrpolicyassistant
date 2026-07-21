import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getChatStore, getInsightsStore } from "@/lib/db";
import { hashUser, log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * 👍/👎 on an answer. Stored with question + answer + citations — this is
 * HR's improvement loop for the document set.
 */
export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const body = (await req.json().catch(() => ({}))) as {
      conversationId?: string;
      messageId?: string;
      rating?: "up" | "down";
    };
    if (!body.conversationId || !body.messageId || !["up", "down"].includes(body.rating ?? "")) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const db = getChatStore();
    const messages = await db.listMessages(user.sub, body.conversationId);
    const idx = messages.findIndex((m) => m.id === body.messageId && m.role === "assistant");
    if (idx === -1) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const answer = messages[idx];
    const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");

    await db.setMessageFeedback(user.sub, body.conversationId, body.messageId, body.rating!);
    await db.saveFeedback({
      userEmail: user.email,
      conversationId: body.conversationId,
      messageId: body.messageId,
      rating: body.rating!,
      question: question?.content ?? "",
      answer: answer.content,
      citations: (answer.citations ?? []).map((c) => ({ title: c.title, uri: c.uri })),
      createdAt: Date.now(),
    });
    // Pre-aggregated dashboard stats — never let a stats failure break feedback.
    try {
      await getInsightsStore().recordFeedbackStat(body.rating!, question?.content ?? "", answer.content, Date.now());
    } catch (statErr) {
      log.error("stats write failed", {
        errorClass: "stats_write",
        detail: statErr instanceof Error ? statErr.message : String(statErr),
      });
    }
    log.info("feedback", { user: hashUser(user.sub), rating: body.rating });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
