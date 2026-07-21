/**
 * Short-TTL cache of identical questions (normalized) to cut Answer API cost
 * on common queries. Only first questions of a conversation are cached —
 * follow-ups depend on session context and must not be shared.
 */
import { createHash } from "crypto";

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

export function questionHash(q: string): string {
  return createHash("sha256").update(normalizeQuestion(q)).digest("hex").slice(0, 32);
}
