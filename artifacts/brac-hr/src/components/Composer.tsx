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
    <div className="safe-bottom px-4 pt-2 sm:px-6">
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
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2.5 py-2 text-base leading-relaxed outline-none disabled:opacity-60 sm:text-[0.95rem]"
          style={{ color: "var(--text)" }}
        />
        <button
          onClick={submit}
          disabled={!active}
          aria-label="Send"
          className="pressable grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white disabled:opacity-30 sm:h-9 sm:w-9"
          style={{
            background: active ? "var(--color-accent-500)" : "var(--border-strong)",
          }}
        >
          <IconSend />
        </button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px]" style={{ color: "var(--text-faint)" }}>
        Answers come from BRAC HR documents and may not cover every case. For official guidance, contact{" "}
        <a href="mailto:hrhelpdesk@brac.net" className="hover:underline" style={{ color: "var(--color-accent-600)" }}>
          hrhelpdesk@brac.net
        </a>
        .
      </p>
    </div>
  );
}
