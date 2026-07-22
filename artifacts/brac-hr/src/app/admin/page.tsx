"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BracLogo } from "@/components/BracLogo";

interface Insights {
  days: number;
  truncated: boolean;
  totals: { questions: number; noResults: number; thumbsDown: number; thumbsUp: number };
  topQuestions: { question: string; count: number }[];
  noResultQuestions: { question: string; askedAt: number }[];
  thumbsDown: { question: string; answer: string; createdAt: number }[];
}

interface RoleChange {
  actorEmail: string;
  actorName: string;
  targetEmail: string;
  targetName: string;
  fromRole: "admin" | "user";
  toRole: "admin" | "user";
  createdAt: number;
}

interface AdminUser {
  sub: string;
  email: string;
  name: string;
  role: "admin" | "user";
  lastSignInAt: number;
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
              : "This dashboard is only available to HR administrators. If you believe you should have access, contact hrhelpdesk@brac.net."}
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
                className="pressable rounded-md px-3 py-1.5 text-xs font-medium"
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
          <div className="mt-6 rounded-xl px-4 py-3 text-sm" role="alert" style={{ background: "#f8e9e9", color: "var(--color-brand-deepred)" }}>
            {errorMsg}
          </div>
        )}

        {status === "ready" && data && (
          <>
            {data.truncated && (
              <div className="mt-6 rounded-xl px-4 py-3 text-sm" style={{ background: "#fff4e0", color: "#7a5200" }}>
                There was too much data to read completely — the numbers below are a lower bound. Try a shorter date range.
              </div>
            )}
            {/* Totals */}
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat index={0} label="Questions asked" value={data.totals.questions} color="var(--color-accent-500)" />
              <Stat index={1} label="No answer found" value={data.totals.noResults} color="var(--color-brand-amber)" />
              <Stat index={2} label="👍 Helpful" value={data.totals.thumbsUp} color="var(--color-brand-sky)" />
              <Stat index={3} label="👎 Not helpful" value={data.totals.thumbsDown} color="var(--color-brand-deepred)" />
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
                  </li>
                ))}
              </ul>
            </Section>

            <UsersAndHistory />
          </>
        )}
      </div>
    </Shell>
  );
}

function UsersAndHistory() {
  // Bump after every role change so the history list refreshes immediately.
  const [historyVersion, setHistoryVersion] = useState(0);
  return (
    <>
      <UsersSection onRoleChanged={() => setHistoryVersion((v) => v + 1)} />
      <RoleChangeHistorySection version={historyVersion} />
    </>
  );
}

function RoleChangeHistorySection({ version }: { version: number }) {
  const [changes, setChanges] = useState<RoleChange[] | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let stale = false;
    fetch("/api/admin/role-changes")
      .then(async (res) => {
        if (stale) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? "Failed to load role change history.");
        }
        const body = (await res.json()) as { changes: RoleChange[] };
        setChanges(body.changes);
        setError("");
      })
      .catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [version]);

  return (
    <Section
      title="Role change history"
      subtitle="Who promoted or demoted whom, and when. Newest first."
      empty={changes !== null && changes.length === 0 && !error}
      emptyText="No role changes recorded yet."
    >
      {error && (
        <div className="mb-3 rounded-xl px-4 py-3 text-sm" role="alert" style={{ background: "var(--color-accent-50)", color: "var(--color-accent-700)" }}>
          {error}
        </div>
      )}
      {changes === null && !error && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
      )}
      {changes !== null && changes.length > 0 && (
        <ul className="flex flex-col">
          {changes.map((c, i) => (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b py-2.5 last:border-0 text-sm" style={{ borderColor: "var(--border)" }}>
              <span style={{ color: "var(--text)" }}>
                <span className="font-medium">{c.actorName || c.actorEmail}</span>
                {" "}{c.toRole === "admin" ? "made" : "changed"}{" "}
                <span className="font-medium">{c.targetName || c.targetEmail}</span>
                {" "}
                {c.toRole === "admin" ? "an admin" : "a regular user"}
                <span style={{ color: "var(--text-muted)" }}> ({c.fromRole} → {c.toRole})</span>
              </span>
              <span className="shrink-0 text-xs" style={{ color: "var(--text-faint)" }}>{fmtDateTime(c.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function UsersSection({ onRoleChanged }: { onRoleChanged: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [me, setMe] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busySub, setBusySub] = useState<string>("");

  const load = () => {
    fetch("/api/admin/users")
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? "Failed to load users.");
        }
        const body = (await res.json()) as { me: string; users: AdminUser[] };
        setMe(body.me);
        setUsers(body.users);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const toggleRole = async (u: AdminUser) => {
    const next = u.role === "admin" ? "user" : "admin";
    setBusySub(u.sub);
    setError("");
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub: u.sub, role: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to update role.");
      }
      setUsers((prev) => prev?.map((x) => (x.sub === u.sub ? { ...x, role: next } : x)) ?? null);
      onRoleChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role.");
    } finally {
      setBusySub("");
    }
  };

  return (
    <Section
      title="Users"
      subtitle="Everyone who has signed in. Admins can open this dashboard; role changes take effect on the user's next page load."
      empty={users !== null && users.length === 0 && !error}
      emptyText="No users have signed in yet."
    >
      {error && (
        <div className="mb-3 rounded-xl px-4 py-3 text-sm" role="alert" style={{ background: "#f8e9e9", color: "var(--color-brand-deepred)" }}>
          {error}
        </div>
      )}
      {users === null && !error && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
      )}
      {users !== null && users.length > 0 && (
        <ul className="flex flex-col">
          {users.map((u) => (
            <li key={u.sub} className="flex flex-wrap items-center justify-between gap-3 border-b py-2.5 last:border-0" style={{ borderColor: "var(--border)" }}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
                  {u.name}
                  {u.sub === me && (
                    <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-faint)" }}>(you)</span>
                  )}
                </p>
                <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                  {u.email} · last sign-in {fmtDate(u.lastSignInAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={u.role === "admin"
                    ? { background: "var(--color-accent-50)", color: "var(--color-accent-700)" }
                    : { background: "var(--code-bg)", color: "var(--text-muted)" }}
                >
                  {u.role === "admin" ? "Admin" : "User"}
                </span>
                <button
                  onClick={() => toggleRole(u)}
                  disabled={busySub === u.sub}
                  className="pressable rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--code-bg)] disabled:opacity-50"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
                >
                  {busySub === u.sub ? "Saving…" : u.role === "admin" ? "Make user" : "Make admin"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
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

function Stat({ label, value, color, index = 0 }: { label: string; value: number; color?: string; index?: number }) {
  return (
    <div
      className="animate-stagger-in rounded-xl border p-4"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-elevated)",
        borderTop: `3px solid ${color ?? "var(--border)"}`,
        ["--stagger-i" as string]: index,
      }}
    >
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
    <section className="animate-rise-in mt-8 rounded-2xl border p-4 sm:p-5" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
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

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
