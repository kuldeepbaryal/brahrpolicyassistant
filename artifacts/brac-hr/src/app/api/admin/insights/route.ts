import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin, AuthError } from "@/lib/auth";
import { getDb, type AdminMessage } from "@/lib/db";
import { log, hashUser } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Legacy detection for assistant messages saved before the noResults flag. */
const NO_RESULTS_PATTERN = /couldn'?t find this in BRAC'?s HR policies/i;

export interface AdminInsights {
  days: number;
  /** True when data volume forced a partial scan — counts are lower bounds. */
  truncated: boolean;
  totals: { questions: number; noResults: number; thumbsDown: number; thumbsUp: number };
  topQuestions: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; createdAt: number }[];
}

function normalize(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function aggregate(messages: AdminMessage[], days: number): Omit<AdminInsights, "thumbsDown" | "totals" | "truncated"> & {
  totals: Pick<AdminInsights["totals"], "questions" | "noResults">;
} {
  // Group by conversation and order chronologically to pair Q → A.
  const byConv = new Map<string, AdminMessage[]>();
  for (const m of messages) {
    if (!byConv.has(m.convKey)) byConv.set(m.convKey, []);
    byConv.get(m.convKey)!.push(m);
  }

  const counts = new Map<string, { question: string; count: number }>();
  const noResultQuestions: { question: string; askedAt: number }[] = [];
  let questionCount = 0;

  for (const msgs of byConv.values()) {
    msgs.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "user") {
        questionCount++;
        const key = normalize(m.content);
        if (key) {
          const entry = counts.get(key) ?? { question: m.content, count: 0 };
          entry.count++;
          counts.set(key, entry);
        }
      } else if (m.noResults || NO_RESULTS_PATTERN.test(m.content)) {
        // Find the user question immediately preceding this assistant answer.
        const q = msgs.slice(0, i).reverse().find((x) => x.role === "user");
        if (q) noResultQuestions.push({ question: q.content, askedAt: m.createdAt });
      }
    }
  }

  const topQuestions = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  noResultQuestions.sort((a, b) => b.askedAt - a.askedAt);

  return {
    days,
    totals: { questions: questionCount, noResults: noResultQuestions.length },
    topQuestions,
    noResultQuestions: noResultQuestions.slice(0, 50),
  };
}

/** GET /api/admin/insights?days=7|30|90 — HR admin dashboard data. */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(user))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
  const since = Date.now() - days * 24 * 3600 * 1000;

  try {
    const db = getDb();
    const [messagesRes, feedbackRes] = await Promise.all([
      db.adminScanMessages(since),
      db.adminScanFeedback(since),
    ]);

    const base = aggregate(messagesRes.items, days);
    const down = feedbackRes.items
      .filter((f) => f.rating === "down")
      .sort((a, b) => b.createdAt - a.createdAt);
    const up = feedbackRes.items.filter((f) => f.rating === "up");

    const insights: AdminInsights = {
      ...base,
      truncated: messagesRes.truncated || feedbackRes.truncated,
      totals: { ...base.totals, thumbsDown: down.length, thumbsUp: up.length },
      // Deliberately no userEmail here — HR needs the Q/A pair, not the person.
      thumbsDown: down.slice(0, 50).map((f) => ({
        question: f.question,
        answer: f.answer,
        createdAt: f.createdAt,
      })),
    };

    log.info("admin insights", { user: hashUser(user.sub), days, messages: messagesRes.items.length });
    return NextResponse.json(insights);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The app's IAM policy must include dynamodb:Scan on the Messages and
    // Feedback tables for this endpoint to work in production.
    const isAccessDenied = /AccessDenied/i.test(detail);
    log.error("admin insights failed", { errorClass: isAccessDenied ? "access_denied" : "api_error" });
    return NextResponse.json(
      {
        error: "server_error",
        message: isAccessDenied
          ? "The app's AWS role is missing the dynamodb:Scan permission needed for the dashboard."
          : "Failed to load insights. Please try again.",
      },
      { status: 500 }
    );
  }
}
