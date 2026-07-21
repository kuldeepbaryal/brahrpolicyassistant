"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/lib/types";
import { CitationChips } from "./CitationChips";
import { IconCheck, IconCopy, IconThumbDown, IconThumbUp } from "./icons";

export function TypingDots() {
  return (
    <div className="flex items-center gap-1.5 py-1" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="typing-dot h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--border-strong)", animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

const WAIT_STAGES: Array<{ afterMs: number; label: string }> = [
  { afterMs: 0, label: "Searching HR policies…" },
  { afterMs: 5000, label: "Generating answer…" },
  { afterMs: 15000, label: "Still working — long questions can take a moment…" },
];

/** Staged progress indicator shown while waiting for the first streamed word. */
function WaitingIndicator() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timers = WAIT_STAGES.slice(1).map((s, i) =>
      setTimeout(() => setStage(i + 1), s.afterMs)
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <div className="flex items-center gap-2.5 py-1" role="status" aria-live="polite">
      <TypingDots />
      <span className="text-sm animate-fade-in" key={stage} style={{ color: "var(--text-muted)" }}>
        {WAIT_STAGES[stage].label}
      </span>
    </div>
  );
}

interface MessageProps {
  message: ChatMessage;
  streaming?: boolean;
  onFeedback?: (rating: "up" | "down") => void;
  onRelatedClick?: (q: string) => void;
}

export function Message({ message, streaming, onFeedback, onRelatedClick }: MessageProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end animate-msg-in">
        <div
          className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[0.95rem] leading-relaxed"
          style={{
            background: "var(--bubble-user)",
            color: "var(--bubble-user-text)",
            border: "1px solid var(--color-accent-200)",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 animate-msg-in">
      {/* Assistant avatar — brand pinwheel mark on the accent tile */}
      <div
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
        style={{ background: "var(--color-accent-500)" }}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/avatar-mark.png" alt="" className="h-5 w-5" />
      </div>

      <div className="min-w-0 flex-1">
        <div
          className="rounded-2xl rounded-tl-md border px-4 py-3"
          style={{
            background: "var(--bubble-assistant)",
            borderColor: "var(--border)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          {message.content ? (
            <div className="prose-answer" style={{ color: "var(--text)" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          ) : (
            <WaitingIndicator />
          )}

          {!streaming && message.citations && <CitationChips citations={message.citations} />}
        </div>

        {!streaming && message.content && (
          <div className="mt-1.5 flex items-center gap-1 pl-1">
            <CopyButton text={message.content} />
            <FeedbackButton
              active={message.feedback === "up"}
              onClick={() => onFeedback?.("up")}
              label="Helpful"
              icon={<IconThumbUp width={14} height={14} />}
            />
            <FeedbackButton
              active={message.feedback === "down"}
              onClick={() => onFeedback?.("down")}
              label="Not helpful"
              icon={<IconThumbDown width={14} height={14} />}
            />
          </div>
        )}

        {!streaming && message.relatedQuestions && message.relatedQuestions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 pl-1">
            {message.relatedQuestions.slice(0, 3).map((q, i) => (
              <button
                key={i}
                onClick={() => onRelatedClick?.(q)}
                className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-[var(--color-accent-50)] hover:border-[var(--color-accent-300)]"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-muted)",
                  background: "var(--bg-elevated)",
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {})}
      aria-label={copied ? "Copied" : "Copy answer"}
      title={copied ? "Copied" : "Copy answer"}
      className="grid h-7 w-7 place-items-center rounded-lg transition-colors active:scale-[0.97]"
      style={{ color: copied ? "var(--color-accent-500)" : "var(--text-faint)" }}
    >
      {copied ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
    </button>
  );
}

function FeedbackButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 place-items-center rounded-lg transition-colors active:scale-[0.97]"
      style={{
        color: active ? "var(--color-accent-500)" : "var(--text-faint)",
        background: active ? "var(--color-accent-50)" : "transparent",
      }}
    >
      {icon}
    </button>
  );
}
