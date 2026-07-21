/**
 * Insights aggregation — the admin dashboard's numbers, computed behind one
 * interface so the logic is callable and testable without HTTP.
 *
 * Two paths, same output shape:
 *   • Fast path: bounded reads over pre-aggregated DailyStats day partitions
 *     (exact counts, never truncated).
 *   • Legacy fallback: full table scans, only while the stats partitions have
 *     no data for the window (right after the stats feature shipped).
 */
import {
  getInsightsStore,
  normalizeQuestion,
  type AdminMessage,
  type FeedbackEvent,
  type InsightsStore,
  type ScanResult,
} from "./db";

export interface AdminInsights {
  days: number;
  /** True only on the legacy scan fallback when data volume forced a partial scan. */
  truncated: boolean;
  totals: { questions: number; noResults: number; thumbsDown: number; thumbsUp: number };
  topQuestions: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; createdAt: number }[];
}

export type InsightsSource = "daily_stats" | "legacy_scan";

/** Legacy detection for assistant messages saved before the noResults flag. */
const NO_RESULTS_PATTERN = /couldn'?t find this in BRAC'?s HR policies/i;

export const TOP_QUESTIONS_LIMIT = 15;
export const LIST_LIMIT = 50;

/**
 * Pure aggregation over flat message scans: pairs each no-result assistant
 * answer with the closest preceding user question in its conversation,
 * counts questions by normalized text, and ranks the most-asked ones.
 * Ties in the ranking keep first-asked order (stable sort).
 */
export function aggregateMessages(
  messages: AdminMessage[],
  days: number
): Pick<AdminInsights, "days" | "topQuestions" | "noResultQuestions"> & {
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
        // Orphan answers (no preceding question in the scan window) are skipped.
        const q = msgs.slice(0, i).reverse().find((x) => x.role === "user");
        if (q) noResultQuestions.push({ question: q.content, askedAt: m.createdAt });
      }
    }
  }

  const topQuestions = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, TOP_QUESTIONS_LIMIT);
  noResultQuestions.sort((a, b) => b.askedAt - a.askedAt);

  return {
    days,
    totals: { questions: questionCount, noResults: noResultQuestions.length },
    topQuestions,
    noResultQuestions: noResultQuestions.slice(0, LIST_LIMIT),
  };
}

/** Combine message aggregation with feedback scans (legacy path shape). */
export function aggregateScans(
  messagesRes: ScanResult<AdminMessage>,
  feedbackRes: ScanResult<FeedbackEvent>,
  days: number
): AdminInsights {
  const base = aggregateMessages(messagesRes.items, days);
  const down = feedbackRes.items
    .filter((f) => f.rating === "down")
    .sort((a, b) => b.createdAt - a.createdAt);
  const up = feedbackRes.items.filter((f) => f.rating === "up");

  return {
    ...base,
    // Truncated scans mean every number below is a lower bound.
    truncated: messagesRes.truncated || feedbackRes.truncated,
    totals: { ...base.totals, thumbsDown: down.length, thumbsUp: up.length },
    // Deliberately no userEmail here — HR needs the Q/A pair, not the person.
    thumbsDown: down.slice(0, LIST_LIMIT).map((f) => ({
      question: f.question,
      answer: f.answer,
      createdAt: f.createdAt,
    })),
  };
}

/**
 * The dashboard data for a window. Prefers exact pre-aggregated daily stats;
 * falls back to legacy scans while the stats partitions are still empty.
 * Storage failures propagate as StorageError.
 */
export async function getAdminInsights(
  days: number,
  since: number,
  store: InsightsStore = getInsightsStore()
): Promise<{ insights: AdminInsights; source: InsightsSource }> {
  // Fast path: bounded reads over pre-aggregated day partitions. Counts are
  // exact — no scans, no truncation — regardless of total history size.
  const daily = await store.getDailyInsights(since);
  const hasStats =
    daily.totals.questions > 0 ||
    daily.totals.thumbsUp > 0 ||
    daily.totals.thumbsDown > 0 ||
    daily.totals.noResults > 0;

  if (hasStats) {
    return {
      source: "daily_stats",
      insights: {
        days,
        truncated: false,
        totals: daily.totals,
        // Sort copies — never mutate arrays owned by the injected store.
        topQuestions: [...daily.questionCounts].sort((a, b) => b.count - a.count).slice(0, TOP_QUESTIONS_LIMIT),
        noResultQuestions: [...daily.noResultQuestions].sort((a, b) => b.askedAt - a.askedAt).slice(0, LIST_LIMIT),
        // Deliberately no userEmail here — HR needs the Q/A pair, not the person.
        thumbsDown: [...daily.thumbsDown].sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_LIMIT),
      },
    };
  }

  // Transition fallback: no aggregated data yet for this window.
  const [messagesRes, feedbackRes] = await Promise.all([
    store.adminScanMessages(since),
    store.adminScanFeedback(since),
  ]);
  return { source: "legacy_scan", insights: aggregateScans(messagesRes, feedbackRes, days) };
}
