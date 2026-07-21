import { describe, expect, it } from "vitest";
import type { AdminMessage, DailyInsightsData, FeedbackEvent, InsightsStore, ScanResult } from "../db";
import { aggregateMessages, aggregateScans, getAdminInsights } from "../insights";

process.env.MOCK_MODE = "true";

function msg(over: Partial<AdminMessage> & { convKey: string; createdAt: number }): AdminMessage {
  return { role: "user", content: "How many leave days do I get?", ...over };
}

function scan<T>(items: T[], truncated = false): ScanResult<T> {
  return { items, truncated };
}

function feedback(over: Partial<FeedbackEvent>): FeedbackEvent {
  return {
    userEmail: "u@brac.net",
    conversationId: "c1",
    messageId: "m1",
    rating: "down",
    question: "Q",
    answer: "A",
    citations: [],
    createdAt: 1000,
    ...over,
  };
}

describe("aggregateMessages", () => {
  it("empty period yields zeroes and empty lists", () => {
    const res = aggregateMessages([], 30);
    expect(res).toEqual({ days: 30, totals: { questions: 0, noResults: 0 }, topQuestions: [], noResultQuestions: [] });
  });

  it("counts orphan questions (no answer) as questions", () => {
    const res = aggregateMessages([msg({ convKey: "c1", createdAt: 1, content: "Orphan question?" })], 7);
    expect(res.totals.questions).toBe(1);
    expect(res.topQuestions).toEqual([{ question: "Orphan question?", count: 1 }]);
    expect(res.totals.noResults).toBe(0);
  });

  it("skips orphan no-result answers with no preceding question", () => {
    const res = aggregateMessages(
      [msg({ convKey: "c1", createdAt: 1, role: "assistant", content: "no luck", noResults: true })],
      7
    );
    expect(res.totals.noResults).toBe(0);
    expect(res.noResultQuestions).toEqual([]);
  });

  it("pairs a no-result answer with the closest preceding user question", () => {
    const res = aggregateMessages(
      [
        msg({ convKey: "c1", createdAt: 1, content: "First?" }),
        msg({ convKey: "c1", createdAt: 3, content: "Second?" }),
        msg({ convKey: "c1", createdAt: 4, role: "assistant", content: "n/a", noResults: true }),
      ],
      7
    );
    expect(res.noResultQuestions).toEqual([{ question: "Second?", askedAt: 4 }]);
  });

  it("detects legacy no-result answers by message text", () => {
    const res = aggregateMessages(
      [
        msg({ convKey: "c1", createdAt: 1, content: "Q?" }),
        msg({
          convKey: "c1",
          createdAt: 2,
          role: "assistant",
          content: "I couldn't find this in BRAC's HR policies.",
        }),
      ],
      7
    );
    expect(res.totals.noResults).toBe(1);
  });

  it("counts duplicate questions by normalized text and ranks by count", () => {
    const res = aggregateMessages(
      [
        msg({ convKey: "c1", createdAt: 1, content: "Maternity leave?" }),
        msg({ convKey: "c2", createdAt: 2, content: "  MATERNITY LEAVE " }),
        msg({ convKey: "c3", createdAt: 3, content: "Sick leave?" }),
      ],
      7
    );
    expect(res.topQuestions[0]).toEqual({ question: "Maternity leave?", count: 2 });
    expect(res.topQuestions[1]).toEqual({ question: "Sick leave?", count: 1 });
  });

  it("breaks top-question ties by first-asked order (stable sort)", () => {
    const res = aggregateMessages(
      [
        msg({ convKey: "c1", createdAt: 1, content: "Alpha?" }),
        msg({ convKey: "c1", createdAt: 2, content: "Beta?" }),
      ],
      7
    );
    expect(res.topQuestions.map((q) => q.question)).toEqual(["Alpha?", "Beta?"]);
  });
});

describe("aggregateScans", () => {
  it("marks output truncated when either scan was partial (lower-bound numbers)", () => {
    expect(aggregateScans(scan<AdminMessage>([], true), scan<FeedbackEvent>([]), 7).truncated).toBe(true);
    expect(aggregateScans(scan<AdminMessage>([]), scan<FeedbackEvent>([], true), 7).truncated).toBe(true);
    expect(aggregateScans(scan<AdminMessage>([]), scan<FeedbackEvent>([]), 7).truncated).toBe(false);
  });

  it("splits feedback into thumbs up/down, newest thumbs-down first, without user emails", () => {
    const res = aggregateScans(
      scan<AdminMessage>([]),
      scan([
        feedback({ rating: "down", question: "Q1", answer: "A1", createdAt: 1 }),
        feedback({ rating: "up", createdAt: 2 }),
        feedback({ rating: "down", question: "Q2", answer: "A2", createdAt: 3 }),
      ]),
      30
    );
    expect(res.totals).toMatchObject({ thumbsUp: 1, thumbsDown: 2 });
    expect(res.thumbsDown).toEqual([
      { question: "Q2", answer: "A2", createdAt: 3 },
      { question: "Q1", answer: "A1", createdAt: 1 },
    ]);
    expect(JSON.stringify(res)).not.toContain("u@brac.net");
  });
});

describe("getAdminInsights source selection", () => {
  function storeWith(daily: DailyInsightsData, scans?: { messages?: AdminMessage[]; feedback?: FeedbackEvent[] }) {
    let scanned = false;
    const store = {
      getDailyInsights: async () => daily,
      adminScanMessages: async () => {
        scanned = true;
        return scan(scans?.messages ?? []);
      },
      adminScanFeedback: async () => scan(scans?.feedback ?? []),
    } as unknown as InsightsStore;
    return { store, wasScanned: () => scanned };
  }

  const emptyDaily: DailyInsightsData = {
    totals: { questions: 0, noResults: 0, thumbsUp: 0, thumbsDown: 0 },
    questionCounts: [],
    noResultQuestions: [],
    thumbsDown: [],
  };

  it("uses exact daily stats when present (never truncated, no scans)", async () => {
    const { store, wasScanned } = storeWith({
      totals: { questions: 5, noResults: 1, thumbsUp: 2, thumbsDown: 1 },
      questionCounts: [
        { question: "B?", count: 1 },
        { question: "A?", count: 3 },
      ],
      noResultQuestions: [
        { question: "old", askedAt: 1 },
        { question: "new", askedAt: 2 },
      ],
      thumbsDown: [{ question: "Q", answer: "A", createdAt: 1 }],
    });
    const { insights, source } = await getAdminInsights(30, 0, store);
    expect(source).toBe("daily_stats");
    expect(wasScanned()).toBe(false);
    expect(insights.truncated).toBe(false);
    expect(insights.topQuestions[0]).toEqual({ question: "A?", count: 3 });
    expect(insights.noResultQuestions[0].question).toBe("new");
  });

  it("falls back to legacy scans when the stats window is empty", async () => {
    const { store, wasScanned } = storeWith(emptyDaily, {
      messages: [msg({ convKey: "c1", createdAt: 1, content: "Q?" })],
    });
    const { insights, source } = await getAdminInsights(7, 0, store);
    expect(source).toBe("legacy_scan");
    expect(wasScanned()).toBe(true);
    expect(insights.totals.questions).toBe(1);
  });
});
