"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/lib/types";
import { api, type PublicUser } from "@/lib/client";
import { BracLogo } from "./BracLogo";
import { IconEdit, IconPlus, IconTrash, IconDotsThree, IconSearch } from "./icons";

interface SidebarProps {
  user: PublicUser;
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
}

export function Sidebar({
  user,
  conversations,
  activeId,
  open,
  onClose,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onSignOut,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  // ids matched server-side (message content); null = no active content search
  const [contentIds, setContentIds] = useState<string[] | null>(null);

  const editRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Debounced server-side content search alongside instant title filtering.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentIds(null);
      return;
    }
    let stale = false; // ignore responses that arrive after the query changed
    const t = setTimeout(() => {
      api
        .searchConversations(q)
        .then((ids) => { if (!stale) setContentIds(ids); })
        .catch(() => { if (!stale) setContentIds(null); });
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [query]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || (contentIds ?? []).includes(c.id)
    );
  }, [conversations, query, contentIds]);

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus();
  }, [editingId]);

  // Close the user menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const commitEdit = (id: string) => {
    const t = editTitle.trim();
    if (t) onRename(id, t);
    setEditingId(null);
  };

  const initial = user.name.charAt(0).toUpperCase();

  const inner = (
    <aside
      className="flex h-full w-64 flex-col"
      style={{ background: "var(--bg-sidebar)", borderRight: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <BracLogo size={24} />
        <button
          onClick={onNew}
          className="grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-[var(--color-accent-50)]"
          style={{ color: "var(--color-accent-500)" }}
          aria-label="New conversation"
          title="New conversation"
        >
          <IconPlus width={16} height={16} />
        </button>
      </div>

      {/* Search */}
      {conversations.length > 0 && (
        <div className="px-3 pt-2.5">
          <div
            className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5"
            style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
          >
            <IconSearch width={14} height={14} style={{ color: "var(--text-faint)" }} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: "var(--text)" }}
            />
          </div>
        </div>
      )}

      {/* Conversation list */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {conversations.length === 0 && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            No conversations yet. Start by asking a question.
          </p>
        )}
        {conversations.length > 0 && visible.length === 0 && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            No conversations match &ldquo;{query.trim()}&rdquo;.
          </p>
        )}
        <ul className="flex flex-col gap-px">
          {visible.map((c) => (
            <li key={c.id}>
              {editingId === c.id ? (
                <div className="flex items-center gap-1 px-1 py-0.5">
                  <input
                    ref={editRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(c.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => commitEdit(c.id)}
                    className="flex-1 rounded-lg border px-2 py-1 text-sm outline-none focus:border-[var(--color-accent-300)]"
                    style={{
                      background: "var(--bg-elevated)",
                      borderColor: "var(--border-strong)",
                      color: "var(--text)",
                    }}
                  />
                </div>
              ) : (
                <div
                  className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors"
                  style={{
                    background: activeId === c.id ? "var(--color-accent-50)" : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={() => { onSelect(c.id); onClose(); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && onSelect(c.id)}
                >
                  <span
                    className="flex-1 truncate text-sm"
                    style={{
                      color: activeId === c.id ? "var(--color-accent-700)" : "var(--text-muted)",
                      fontWeight: activeId === c.id ? 500 : 400,
                    }}
                  >
                    {c.title}
                  </span>
                  <div className="hidden gap-0.5 group-hover:flex">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditTitle(c.title);
                        setEditingId(c.id);
                      }}
                      className="grid h-6 w-6 place-items-center rounded transition-colors hover:text-[var(--text)]"
                      style={{ color: "var(--text-faint)" }}
                      aria-label="Rename"
                    >
                      <IconEdit width={13} height={13} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                      className="grid h-6 w-6 place-items-center rounded transition-colors hover:text-[var(--color-accent-500)]"
                      style={{ color: "var(--text-faint)" }}
                      aria-label="Delete"
                    >
                      <IconTrash width={13} height={13} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* User footer */}
      <div className="border-t p-3" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          {/* Avatar */}
          <div
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
            style={{ background: "var(--color-accent-500)" }}
          >
            {initial}
          </div>

          {/* Name / email */}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
              {user.name}
            </div>
            <div className="truncate text-xs" style={{ color: "var(--text-faint)" }}>
              {user.email}
            </div>
          </div>

          {/* Three-dot menu */}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="User menu"
              aria-expanded={menuOpen}
              className="grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-[var(--border)]"
              style={{ color: menuOpen ? "var(--text)" : "var(--text-faint)" }}
            >
              <IconDotsThree width={16} height={16} />
            </button>

            {menuOpen && (
              <div
                className="absolute bottom-full right-0 mb-1.5 w-36 overflow-hidden rounded-lg border py-1 shadow-md"
                style={{
                  background: "var(--bg-elevated)",
                  borderColor: "var(--border-strong)",
                  boxShadow: "var(--shadow)",
                }}
              >
                <button
                  onClick={() => { setMenuOpen(false); onSignOut(); }}
                  className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-sidebar)]"
                  style={{ color: "var(--text)" }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop sidebar — always visible */}
      <div className="hidden md:flex md:flex-col" style={{ width: 256 }}>
        {inner}
      </div>

      {/* Mobile overlay — controlled by parent */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={onClose}>
          <div className="absolute inset-0" style={{ background: "rgba(28,23,21,0.3)" }} />
          <div
            className="absolute inset-y-0 left-0 z-50"
            onClick={(e) => e.stopPropagation()}
          >
            {inner}
          </div>
        </div>
      )}
    </>
  );
}
