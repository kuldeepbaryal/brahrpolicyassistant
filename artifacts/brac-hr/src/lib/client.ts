"use client";

import type { ChatMessage, Conversation, Citation } from "./types";

export interface PublicUser {
  email: string;
  name: string;
  picture?: string;
  isAdmin?: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  async getMe(): Promise<PublicUser | null> {
    const res = await fetch("/api/auth/session", { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()).user;
  },
  async signIn(credential: string): Promise<PublicUser> {
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    return (await json<{ user: PublicUser }>(res)).user;
  },
  async signOut(): Promise<void> {
    await fetch("/api/auth/session", { method: "DELETE" });
  },
  async listConversations(): Promise<Conversation[]> {
    const res = await fetch("/api/conversations");
    return (await json<{ conversations: Conversation[] }>(res)).conversations;
  },
  async createConversation(title = "New conversation"): Promise<Conversation> {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return (await json<{ conversation: Conversation }>(res)).conversation;
  },
  async getConversation(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
    return json(await fetch(`/api/conversations/${id}`));
  },
  async renameConversation(id: string, title: string): Promise<void> {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  },
  async deleteConversation(id: string): Promise<void> {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  },
  async searchConversations(q: string): Promise<string[]> {
    const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`);
    return (await json<{ ids: string[] }>(res)).ids;
  },
  async sendFeedback(conversationId: string, messageId: string, rating: "up" | "down"): Promise<void> {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, messageId, rating }),
    });
  },
};

export interface StreamHandlers {
  onMeta?: (d: { userMessageId: string; assistantMessageId: string }) => void;
  onDelta?: (text: string) => void;
  onSources?: (d: { citations: Citation[]; relatedQuestions: string[] }) => void;
  onDone?: (d: { remaining: number }) => void;
  onError?: (message: string) => void;
}

/** Stream an answer over SSE from POST /api/chat. */
export async function streamChat(
  conversationId: string,
  question: string,
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, question }),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    handlers.onError?.(err.message ?? "Request failed. Please try again.");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const chunk of events) {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7).trim();
      const data = JSON.parse(dataLine.slice(6));
      if (event === "meta") handlers.onMeta?.(data);
      else if (event === "delta") handlers.onDelta?.(data.text);
      else if (event === "sources") handlers.onSources?.(data);
      else if (event === "done") handlers.onDone?.(data);
      else if (event === "error") handlers.onError?.(data.message);
    }
  }
}
