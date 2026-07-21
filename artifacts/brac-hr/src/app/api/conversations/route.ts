import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, AuthError } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const conversations = await getDb().listConversations(user.sub);
    return NextResponse.json({ conversations });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "server_error", message: "Failed to load conversations." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    const title = (body.title ?? "New conversation").slice(0, 120);
    const conversation = await getDb().createConversation(user.sub, title);
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: "unauthorized", message: "Session expired. Please sign out and sign back in." },
        { status: 401 }
      );
    }
    // Configuration or database error — surface a helpful message.
    const detail = err instanceof Error ? err.message : String(err);
    console.error("createConversation failed:", detail);
    return NextResponse.json(
      { error: "server_error", message: "Service configuration error. Check GCP_PROJECT_ID and Firestore credentials." },
      { status: 500 }
    );
  }
}
