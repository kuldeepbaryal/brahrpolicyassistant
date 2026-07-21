"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BracLogo } from "@/components/BracLogo";

interface Insights {
  days: number;
  totals: { questions: number; noResults: number; thumbsDown: number; thumbsUp: number };
  topQuestions: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; userEmail: string; createdAt: number }[];
}

type Status = "loading" | "unauthorized" | "forbidden" | "error" | "ready";

const RANGES = [7, 30, 90] as const;

export default function AdminPage() {
  const [days, setDays] = useState<number>(30);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [data, setData] = useState<Insights | null>(null);

  useEffect(() => {
    let stale = false;
    setStatus("loading");
    fetch(`/api/admin/insights?days=${days}`)
      .then(async (res) => {
        if (stale) return;
        if (res.status === 401) return setStatus("unauthorized");
        if (res.status === 403) return setStatus("forbidden");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.message ?? "Failed to load insights.");
          return setStatus("error");
        }
        setData(await res.json());
        setStatus("ready");
      })
      .catch(() => { if (!stale) { setErrorMsg("Failed to load insights."); setStatus("error"); } });
    return () => { stale = true; };
  }, [days]);

  if (status === "unauthorized" || status === "forbidden") {
    return (
      <Shell>
        <div className="mx-auto mt-24 max-w-md rounded-2xl border p-8 text-center" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            {status === "unauthorized" ? "Please sign in" : "Not authorized"}
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            {status === "unauthorized"
              ? "Sign in on the main page first, then come back here."
              : "This dashboard is only available to HR administrators. If you believe you should have access, contact hr@brac.net."}
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ background: "var(--color-accent-500)" }}
          >
            Back to the assistant
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}>
              HR Insights
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
              What staff are asking, and where answers fall short.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border p-1" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                style={days === r
                  ? { background: "var(--color-accent-500)", color: "#fff" }
                  : { color: "var(--text-muted)" }}
              >
                {r} days
              </button>
            ))}
          </div>
        </div>

        {status === "loading" && (
          <p className="mt-10 text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
        )}
        {status === "error" && (
          <div className="mt-6 rounded-xl px-4 py-3 text-sm" role="alert" style={{ background: "var(--color-accent-50)", color: "var(--color-accent-700)" }}>
            {errorMsg}
          </div>
        )}

        {status === "ready" && data && (
          <>
            {/* Totals */}
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Questions asked" value={data.totals.questions} />
              <Stat label="No answer found" value={data.totals.noResults} />
              <Stat label="👍 Helpful" value={data.totals.thumbsUp} />
              <Stat label="👎 Not helpful" value={data.totals.thumbsDown} />
            </div>

            <Section title="Most-asked questions" empty={data.topQuestions.length === 0} emptyText="No questions in this period.">
              <ol className="flex flex-col">
                {data.topQuestions.map((q, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-4 border-b py-2.5 last:border-0 text-sm" style={{ borderColor: "var(--border)" }}>
                    <span style={{ color: "var(--text)" }}>{q.question}</span>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: "var(--code-bg)", color: "var(--text-muted)" }}>
                      ×{q.count}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>

            <Section
              title="Questions with no answer in the documents"
              subtitle="These may point to missing or unclear policy documents in the knowledge base."
              empty={data.noResultQuestions.length === 0}
              emptyText="Every question found an answer in this period."
            >
              <ul className="flex flex-col">
                {data.noResultQuestions.map((q, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-4 border-b py-2.5 last:border-0 text-sm" style={{ borderColor: "var(--border)" }}>
                    <span style={{ color: "var(--text)" }}>{q.question}</span>
                    <span className="shrink-0 text-xs" style={{ color: "var(--text-faint)" }}>{fmtDate(q.askedAt)}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="Answers rated 👎"
              subtitle="Full question and answer, so HR can judge what went wrong."
              empty={data.thumbsDown.length === 0}
              emptyText="No negative ratings in this period."
            >
              <ul className="flex flex-col gap-3">
                {data.thumbsDown.map((f, i) => (
                  <li key={i} className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium" style={{ color: "var(--text)" }}>{f.question || "(question unavailable)"}</p>
                      <span className="shrink-0 text-xs" style={{ color: "var(--text-faint)" }}>{fmtDate(f.createdAt)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
                      {f.answer.length > 600 ? f.answer.slice(0, 600) + "…" : f.answer}
                    </p>
                    <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>{f.userEmail}</p>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh" style={{ background: "var(--bg)" }}>
      <header className="flex items-center justify-between border-b px-4 py-3 sm:px-6" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
        <div className="flex items-center gap-2.5">
          <BracLogo size={24} />
          <span className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}>
            Admin
          </span>
        </div>
        <Link href="/" className="text-sm hover:underline" style={{ color: "var(--color-accent-600)" }}>
          ← Back to assistant
        </Link>
      </header>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
      <p className="text-2xl font-semibold" style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}>{value}</p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{label}</p>
    </div>
  );
}

function Section({
  title,
  subtitle,
  empty,
  emptyText,
  children,
}: {
  title: string;
  subtitle?: string;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 rounded-2xl border p-5" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
      <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>{subtitle}</p>}
      <div className="mt-3">
        {empty ? <p className="text-sm" style={{ color: "var(--text-muted)" }}>{emptyText}</p> : children}
      </div>
    </section>
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
