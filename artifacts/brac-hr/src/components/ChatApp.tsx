"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type PublicUser } from "@/lib/client";
import type { ChatMessage, Conversation } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { Message } from "./Message";
import { IconMenu, IconRefresh } from "./icons";

export function ChatApp({ user, onSignOut }: { user: PublicUser; onSignOut: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    api.listConversations().then(setConversations).catch(() => {});
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
    try {
      const { messages } = await api.getConversation(id);
      setMessages(messages);
      scrollToBottom();
    } catch {
      setMessages([]);
    }
  }, [scrollToBottom]);

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
    setInput("");
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (sending) return;
      setBanner(null);
      setFailedQuestion(null);
      setSending(true);
      setInput("");

      // Ensure a conversation exists.
      let convId = activeId;
      if (!convId) {
        try {
          const conv = await api.createConversation(text.slice(0, 60));
          convId = conv.id;
          setActiveId(conv.id);
          setConversations((prev) => [conv, ...prev]);
        } catch {
          setBanner("Couldn't start a conversation. Please try again.");
          setSending(false);
          return;
        }
      }

      const userMsg: ChatMessage = { id: `tmp-u-${Date.now()}`, role: "user", content: text, createdAt: Date.now() };
      const assistantMsg: ChatMessage = { id: `tmp-a-${Date.now()}`, role: "assistant", content: "", createdAt: Date.now() };
      streamingIdRef.current = assistantMsg.id;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      scrollToBottom();

      let acc = "";
      await streamChat(convId, text, {
        onMeta: ({ userMessageId, assistantMessageId }) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === userMsg.id
                ? { ...m, id: userMessageId }
                : m.id === assistantMsg.id
                ? { ...m, id: assistantMessageId }
                : m
            )
          );
          streamingIdRef.current = assistantMessageId;
        },
        onDelta: (t) => {
          // Capture the id synchronously — setMessages updaters run lazily, and
          // streamingIdRef is reset to null once the stream ends.
          const id = streamingIdRef.current;
          acc += t;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: acc } : m)));
          scrollToBottom();
        },
        onSources: ({ citations, relatedQuestions }) => {
          const id = streamingIdRef.current;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, citations, relatedQuestions } : m)));
        },
        onError: (message) => {
          const id = streamingIdRef.current;
          setBanner(message);
          setFailedQuestion(text);
          // Drop the empty assistant placeholder if nothing streamed.
          setMessages((prev) => prev.filter((m) => !(m.id === id && !m.content)));
        },
      });

      streamingIdRef.current = null;
      setSending(false);
      // Refresh sidebar titles (first turn renames the conversation).
      api.listConversations().then(setConversations).catch(() => {});
      scrollToBottom();
    },
    [activeId, sending, scrollToBottom]
  );

  const handleFeedback = useCallback(
    async (messageId: string, rating: "up" | "down") => {
      if (!activeId) return;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)));
      await api.sendFeedback(activeId, messageId, rating).catch(() => {});
    },
    [activeId]
  );

  const handleRename = useCallback(async (id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    await api.renameConversation(id, title).catch(() => {});
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) startNew();
      await api.deleteConversation(id).catch(() => {});
    },
    [activeId, startNew]
  );

  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: "var(--bg)" }}>
      <Sidebar
        user={user}
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={startNew}
        onSelect={openConversation}
        onRename={handleRename}
        onDelete={handleDelete}
        onSignOut={onSignOut}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="safe-top flex items-center gap-2 border-b px-3 py-2.5 md:hidden" style={{ borderColor: "var(--border)" }}>
          <button className="pressable touch-target grid h-10 w-10 place-items-center rounded-lg hover:bg-[var(--code-bg)]" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <IconMenu />
          </button>
          <span className="font-semibold" style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}>
            Policy Assistant
          </span>
        </div>

        {banner && (
          <div className="mx-auto mt-3 w-full max-w-3xl px-4">
            <div
              className="flex items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-sm animate-fade-in"
              style={{ background: "var(--color-accent-50)", color: "var(--color-accent-700)" }}
              role="alert"
            >
              <span>{banner}</span>
              {failedQuestion && (
                <button
                  disabled={sending}
                  onClick={() => {
                    if (sending) return;
                    const q = failedQuestion;
                    setFailedQuestion(null);
                    setBanner(null);
                    if (q) send(q);
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition-colors hover:bg-white"
                  style={{ borderColor: "var(--color-accent-300)", color: "var(--color-accent-700)" }}
                >
                  <IconRefresh width={13} height={13} /> Retry
                </button>
              )}
            </div>
          </div>
        )}

        {messages.length === 0 ? (
          <EmptyState onPick={send} />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
              {messages.map((m) => (
                <Message
                  key={m.id}
                  message={m}
                  streaming={m.id === streamingIdRef.current && sending}
                  onFeedback={(r) => handleFeedback(m.id, r)}
                  onRelatedClick={send}
                />
              ))}
            </div>
          </div>
        )}

        <Composer value={input} onValueChange={setInput} onSend={send} disabled={sending} />
      </main>
    </div>
  );
}
