import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin, AuthError } from "@/lib/auth";
import { getInsightsStore, normalizeQuestion, StorageError, type AdminMessage } from "@/lib/db";
import { log, hashUser } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Legacy detection for assistant messages saved before the noResults flag. */
const NO_RESULTS_PATTERN = /couldn'?t find this in BRAC'?s HR policies/i;

export interface AdminInsights {
  days: number;
  /** True only on the legacy scan fallback when data volume forced a partial scan. */
  truncated: boolean;
  totals: { questions: number; noResults: number; thumbsDown: number; thumbsUp: number };
  topQuestions: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; createdAt: number }[];
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
        const key = normalizeQuestion(m.content);
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

/**
 * Legacy path: full table scans. Only used while the pre-aggregated DailyStats
 * table has no data yet (i.e. right after this feature ships, before any new
 * chat/feedback activity). Once stats exist, reads are bounded and exact.
 */
async function legacyScanInsights(days: number, since: number): Promise<AdminInsights> {
  const db = getInsightsStore();
  const [messagesRes, feedbackRes] = await Promise.all([
    db.adminScanMessages(since),
    db.adminScanFeedback(since),
  ]);

  const base = aggregate(messagesRes.items, days);
  const down = feedbackRes.items
    .filter((f) => f.rating === "down")
    .sort((a, b) => b.createdAt - a.createdAt);
  const up = feedbackRes.items.filter((f) => f.rating === "up");

  return {
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
  // Window = the last N UTC calendar days including today, starting at day
  // boundary. This matches the day granularity of the pre-aggregated stats
  // partitions, so counters and event lists share exactly the same window.
  const now = new Date();
  const since =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (days - 1) * 24 * 3600 * 1000;

  try {
    const db = getInsightsStore();

    // Fast path: bounded reads over pre-aggregated day partitions. Counts are
    // exact — no scans, no truncation — regardless of total history size.
    const daily = await db.getDailyInsights(since);
    const hasStats =
      daily.totals.questions > 0 ||
      daily.totals.thumbsUp > 0 ||
      daily.totals.thumbsDown > 0 ||
      daily.totals.noResults > 0;

    let insights: AdminInsights;
    let source: "daily_stats" | "legacy_scan";
    if (hasStats) {
      source = "daily_stats";
      insights = {
        days,
        truncated: false,
        totals: daily.totals,
        topQuestions: daily.questionCounts.sort((a, b) => b.count - a.count).slice(0, 15),
        noResultQuestions: daily.noResultQuestions
          .sort((a, b) => b.askedAt - a.askedAt)
          .slice(0, 50),
        // Deliberately no userEmail here — HR needs the Q/A pair, not the person.
        thumbsDown: daily.thumbsDown.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
      };
    } else {
      // Transition fallback: no aggregated data yet for this window.
      source = "legacy_scan";
      insights = await legacyScanInsights(days, since);
    }

    log.info("admin insights", { user: hashUser(user.sub), days, source });
    return NextResponse.json(insights);
  } catch (err) {
    // The app's storage identity must be able to read the DailyStats data
    // (and scan Messages/Feedback for the legacy fallback) for this endpoint
    // to work in production.
    const isAccessDenied = err instanceof StorageError && err.code === "permission_denied";
    log.error("admin insights failed", { errorClass: isAccessDenied ? "access_denied" : "api_error" });
    return NextResponse.json(
      {
        error: "server_error",
        message: isAccessDenied
          ? "The app's storage permissions are missing reads on the stats data (and scans on Messages/Feedback) needed for the dashboard."
          : "Failed to load insights. Please try again.",
      },
      { status: 500 }
    );
  }
}
