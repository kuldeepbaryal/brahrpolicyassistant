"use client";

const STARTERS = [
  "How many days of annual leave do I get?",
  "What is the maternity leave policy?",
  "How long is the probation period?",
  "How do I claim medical expenses?",
];

export function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center animate-fade-in">
      {/* Avatar — flat, no gradient */}
      <div
        className="grid h-14 w-14 place-items-center rounded-xl text-xl font-bold text-white"
        style={{ background: "var(--color-accent-500)" }}
        aria-hidden
      >
        H
      </div>

      <h2
        className="mt-5 text-xl font-semibold tracking-tight"
        style={{ color: "var(--text)" }}
      >
        How can I help with HR today?
      </h2>
      <p
        className="mt-2 max-w-sm text-sm leading-relaxed"
        style={{ color: "var(--text-muted)" }}
      >
        Ask about leave, benefits, payroll, or any BRAC HR policy. I&apos;ll answer from
        official HR documents and show you the sources.
      </p>

      {/* Starter questions — no eyebrow label, just the question */}
      <div className="mt-7 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {STARTERS.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="rounded-xl border px-4 py-3.5 text-left text-sm transition-colors hover:border-[var(--color-accent-300)] hover:bg-[var(--color-accent-50)]"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border-strong)",
              color: "var(--text-muted)",
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
