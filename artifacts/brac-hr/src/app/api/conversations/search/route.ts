import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many recent conversations to scan message content for. */
const CONTENT_SCAN_LIMIT = 30;

/**
 * GET /api/conversations/search?q=...
 * Returns ids of the user's conversations whose title OR message content
 * matches the query (case-insensitive substring).
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    if (!q || q.length > 200) return NextResponse.json({ ids: [] });

    const db = getDb();
    const conversations = await db.listConversations(user.sub);
    const ids = new Set<string>();

    for (const c of conversations) {
      if (c.title.toLowerCase().includes(q)) ids.add(c.id);
    }

    // Scan message content of the most recent conversations not already matched.
    const toScan = conversations.filter((c) => !ids.has(c.id)).slice(0, CONTENT_SCAN_LIMIT);
    const results = await Promise.all(
      toScan.map(async (c) => {
        const messages = await db.listMessages(user.sub, c.id);
        return messages.some((m) => m.content.toLowerCase().includes(q)) ? c.id : null;
      })
    );
    for (const id of results) if (id) ids.add(id);

    return NextResponse.json({ ids: [...ids] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
