"use client";

import { useState } from "react";
import type { Citation } from "@/lib/types";
import { IconLink } from "./icons";

export function CitationChips({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!citations.length) return null;

  return (
    <div className="mt-3.5">
      <div
        className="mb-1.5 text-[11px] font-medium uppercase tracking-wide"
        style={{ color: "var(--text-faint)" }}
      >
        Sources
      </div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((c, i) => (
          <button
            key={i}
            onClick={() => setOpen(open === i ? null : i)}
            className="group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-accent-300)] hover:bg-[var(--color-accent-50)]"
            style={{
              background: open === i ? "var(--color-accent-50)" : "var(--bg)",
              borderColor: open === i ? "var(--color-accent-300)" : "var(--border-strong)",
              color: "var(--text-muted)",
            }}
            aria-expanded={open === i}
          >
            {/* Citation number — flat, no gradient */}
            <span
              className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
              style={{ background: "var(--color-accent-500)" }}
            >
              {i + 1}
            </span>
            <span className="max-w-[220px] truncate">{c.title}</span>
          </button>
        ))}
      </div>

      {open !== null && (
        <div
          className="mt-2 rounded-xl border p-3.5 text-sm animate-fade-in"
          style={{
            background: "var(--color-accent-50)",
            borderColor: "var(--color-accent-200)",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="font-medium" style={{ color: "var(--text)" }}>
              {citations[open].title}
            </div>
            {citations[open].uri && (
              <a
                href={citations[open].uri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs hover:underline"
                style={{ color: "var(--color-accent-600)" }}
              >
                <IconLink width={13} height={13} /> Open
              </a>
            )}
          </div>
          {citations[open].snippet && (
            <p className="mt-1.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              {citations[open].snippet}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
