import { describe, expect, it } from "vitest";
import { MemoryDb } from "../db";
import { QuotaError } from "../discovery";
import {
  startChat,
  NO_RESULTS_MESSAGE,
  QUOTA_MESSAGE,
  ERROR_MESSAGE,
  type ChatEvent,
  type KnowledgeBasePort,
} from "../chat";
import type { AnswerResult } from "../types";

process.env.MOCK_MODE = "true";

const USER = { sub: "user-1" };
const noSleep = async () => {};

function answer(over: Partial<AnswerResult> = {}): AnswerResult {
  return {
    answerText: "You get 20 days of annual leave.",
    citations: [{ title: "Policy.pdf", uri: "s3://x/Policy.pdf", snippet: "…" }],
    relatedQuestions: ["How do I apply?"],
    sessionName: "session-1",
    noResults: false,
    ...over,
  };
}

function mockKb(result: AnswerResult | Error): KnowledgeBasePort & { calls: number } {
  const kb = {
    calls: 0,
    createSession: async () => null,
    answer: async () => {
      kb.calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return kb;
}

async function collect(events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function byEvent(events: ChatEvent[], name: ChatEvent["event"]) {
  return events.filter((e) => e.event === name);
}

function fullText(events: ChatEvent[]): string {
  return byEvent(events, "delta")
    .map((e) => (e.data as { text: string }).text)
    .join("");
}

async function setup() {
  const db = new MemoryDb();
  const conv = await db.createConversation(USER.sub, "New chat");
  return { db, conv };
}

describe("startChat pre-stream failures", () => {
  it("returns not_found for an unknown conversation", async () => {
    const db = new MemoryDb();
    const res = await startChat(USER, "nope", "Q?", { chat: db, insights: db, kb: mockKb(answer()), sleep: noSleep });
    expect(res).toEqual({ ok: false, error: "not_found" });
  });

  it("rejects when the hourly rate limit is exhausted (KB never called)", async () => {
    const { db, conv } = await setup();
    const kb = mockKb(answer());
    const limited = new Proxy(db, {
      get(t, p, r) {
        if (p === "incrementRateCounter") return async () => 1000;
        return Reflect.get(t, p, r);
      },
    }) as unknown as MemoryDb;
    const res = await startChat(USER, conv.id, "Q?", { chat: limited, insights: db, kb, sleep: noSleep });
    expect(res).toMatchObject({ ok: false, error: "rate_limited" });
    expect(kb.calls).toBe(0);
  });
});

describe("startChat happy path", () => {
  it("streams meta → deltas → sources → done, persists both messages, records stats", async () => {
    const { db, conv } = await setup();
    const kb = mockKb(answer());
    const res = await startChat(USER, conv.id, "How much annual leave?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!res.ok) throw new Error("expected ok");
    const events = await collect(res.events);

    expect(events[0].event).toBe("meta");
    expect(fullText(events)).toBe("You get 20 days of annual leave.");
    const sources = byEvent(events, "sources")[0].data as { citations: unknown[]; relatedQuestions: string[] };
    expect(sources.citations).toEqual(answer().citations); // citation passthrough
    expect(sources.relatedQuestions).toEqual(["How do I apply?"]);
    expect(events[events.length - 1].event).toBe("done");

    const msgs = await db.listMessages(USER.sub, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("You get 20 days of annual leave.");
    expect(msgs[1].citations).toEqual(answer().citations);

    // First turn renames the conversation to the question.
    expect((await db.getConversation(USER.sub, conv.id))!.title).toBe("How much annual leave?");

    // Stats recorded: one question, no no-result.
    const daily = await db.getDailyInsights(0);
    expect(daily.totals.questions).toBe(1);
    expect(daily.totals.noResults).toBe(0);
  });

  it("caches first-turn answers and serves the second ask from cache (KB called once)", async () => {
    const { db, conv } = await setup();
    const kb = mockKb(answer());
    const first = await startChat(USER, conv.id, "Maternity leave?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!first.ok) throw new Error("expected ok");
    await collect(first.events);
    expect(kb.calls).toBe(1);

    // Same question, new conversation → first turn again → cache hit.
    const conv2 = await db.createConversation(USER.sub, "New chat");
    const second = await startChat(USER, conv2.id, "Maternity leave?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!second.ok) throw new Error("expected ok");
    const events = await collect(second.events);
    expect(kb.calls).toBe(1); // not called again
    expect(fullText(events)).toBe("You get 20 days of annual leave.");
  });

  it("does not use the cache on follow-up turns", async () => {
    const { db, conv } = await setup();
    await db.setCachedAnswer("whatever", answer());
    await db.addMessage(USER.sub, conv.id, { id: "m1", role: "user", content: "prior", createdAt: 1 });
    const kb = mockKb(answer());
    const res = await startChat(USER, conv.id, "Follow-up?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!res.ok) throw new Error("expected ok");
    await collect(res.events);
    expect(kb.calls).toBe(1); // KB queried despite cache entries existing
  });

  it("persists the engine session returned by the KB", async () => {
    const { db, conv } = await setup();
    const res = await startChat(USER, conv.id, "Q?", {
      chat: db,
      insights: db,
      kb: mockKb(answer({ sessionName: "new-session" })),
      sleep: noSleep,
    });
    if (!res.ok) throw new Error("expected ok");
    await collect(res.events);
    expect((await db.getConversation(USER.sub, conv.id))!.engineSessionName).toBe("new-session");
  });
});

describe("startChat no-result handling", () => {
  it("substitutes the friendly message, drops citations, flags the message, records the stat, skips cache", async () => {
    const { db, conv } = await setup();
    const kb = mockKb(answer({ noResults: true, answerText: "" }));
    const res = await startChat(USER, conv.id, "Unknown thing?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!res.ok) throw new Error("expected ok");
    const events = await collect(res.events);

    expect(fullText(events)).toBe(NO_RESULTS_MESSAGE);
    expect((byEvent(events, "sources")[0].data as { citations: unknown[] }).citations).toEqual([]);

    const msgs = await db.listMessages(USER.sub, conv.id);
    expect(msgs[1].noResults).toBe(true);

    const daily = await db.getDailyInsights(0);
    expect(daily.totals.noResults).toBe(1);

    // No-result answers are never cached: a second ask hits the KB again.
    const conv2 = await db.createConversation(USER.sub, "New chat");
    const again = await startChat(USER, conv2.id, "Unknown thing?", { chat: db, insights: db, kb, sleep: noSleep });
    if (!again.ok) throw new Error("expected ok");
    await collect(again.events);
    expect(kb.calls).toBe(2);
  });
});

describe("startChat failures inside the stream", () => {
  it("maps quota errors to the friendly quota message", async () => {
    const { db, conv } = await setup();
    const res = await startChat(USER, conv.id, "Q?", {
      chat: db,
      insights: db,
      kb: mockKb(new QuotaError("throttled")),
      sleep: noSleep,
    });
    if (!res.ok) throw new Error("expected ok");
    const events = await collect(res.events);
    expect(events.map((e) => e.event)).toEqual(["meta", "error"]);
    expect((byEvent(events, "error")[0].data as { message: string }).message).toBe(QUOTA_MESSAGE);
    expect(await db.listMessages(USER.sub, conv.id)).toEqual([]); // nothing persisted
  });

  it("maps other errors to the generic message", async () => {
    const { db, conv } = await setup();
    const res = await startChat(USER, conv.id, "Q?", {
      chat: db,
      insights: db,
      kb: mockKb(new Error("boom")),
      sleep: noSleep,
    });
    if (!res.ok) throw new Error("expected ok");
    const events = await collect(res.events);
    expect((byEvent(events, "error")[0].data as { message: string }).message).toBe(ERROR_MESSAGE);
  });

  it("a stats write failure never breaks the chat", async () => {
    const { db, conv } = await setup();
    const failingStats = new Proxy(db, {
      get(t, p, r) {
        if (p === "recordQuestionAsked") return async () => { throw new Error("stats down"); };
        return Reflect.get(t, p, r);
      },
    }) as unknown as MemoryDb;
    const res = await startChat(USER, conv.id, "Q?", { chat: db, insights: failingStats, kb: mockKb(answer()), sleep: noSleep });
    if (!res.ok) throw new Error("expected ok");
    const events = await collect(res.events);
    expect(events[events.length - 1].event).toBe("done");
    expect((await db.listMessages(USER.sub, conv.id)).length).toBe(2);
  });
});
