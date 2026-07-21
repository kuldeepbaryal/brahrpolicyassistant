/**
 * Per-user hourly rate limit backed by Firestore counters (shared across all
 * Cloud Run instances). Fixed-window: users/{sub} + current UTC hour.
 */
import { config } from "./config";
import type { Db } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export function windowKeyFor(sub: string, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  return `${sub}_${y}${m}${d}${h}`;
}

export async function checkRateLimit(db: Db, sub: string, now = new Date()): Promise<RateLimitResult> {
  const limit = config.rateLimitPerHour;
  const count = await db.incrementRateCounter(sub, windowKeyFor(sub, now));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
}
