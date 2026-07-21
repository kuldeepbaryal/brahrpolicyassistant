"use client";

import { useEffect, useRef } from "react";
import { IconSend } from "./icons";

interface ComposerProps {
  value: string;
  onValueChange: (v: string) => void;
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function Composer({ value, onValueChange, onSend, disabled }: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
  };

  const active = !!value.trim() && !disabled;

  return (
    <div className="px-4 pb-5 pt-2 sm:px-6">
      <div
        className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border p-2 transition-shadow focus-within:shadow-md"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border-strong)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask about BRAC HR policies..."
          disabled={disabled}
          aria-label="Ask an HR question"
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[0.95rem] leading-relaxed outline-none disabled:opacity-60"
          style={{ color: "var(--text)" }}
        />
        <button
          onClick={submit}
          disabled={!active}
          aria-label="Send"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white transition-all active:scale-[0.96] disabled:opacity-30"
          style={{
            background: active ? "var(--color-accent-500)" : "var(--border-strong)",
          }}
        >
          <IconSend />
        </button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px]" style={{ color: "var(--text-faint)" }}>
        Answers come from BRAC HR documents and may not cover every case. For official guidance, contact{" "}
        <a href="mailto:hr@brac.net" className="hover:underline" style={{ color: "var(--color-accent-600)" }}>
          hr@brac.net
        </a>
        .
      </p>
    </div>
  );
}
