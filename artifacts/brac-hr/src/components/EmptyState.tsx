"use client";

const STARTERS = [
  "How do I report a safeguarding concern?",
  "What counts as workplace bullying or violence?",
  "How do I raise a whistleblowing complaint?",
  "What is the sexual harassment complaint process?",
];

export function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center animate-rise-in">
      {/* Avatar — flat, no gradient */}
      <div
        className="grid h-14 w-14 place-items-center rounded-xl"
        style={{ background: "var(--color-accent-500)" }}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/avatar-mark.png" alt="" className="h-8 w-8" />
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
        {STARTERS.map((q, i) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="pressable animate-stagger-in rounded-xl border px-4 py-3.5 text-left text-sm hover:border-[var(--color-accent-300)] hover:bg-[var(--color-accent-50)] hover:shadow-sm"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border-strong)",
              color: "var(--text-muted)",
              ["--stagger-i" as string]: i + 2,
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
