import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getChatStore } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const { id } = await params;
    const conversation = await getChatStore().getConversation(user.sub, id);
    if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const messages = await getChatStore().listMessages(user.sub, id);
    return NextResponse.json({ conversation, messages });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    if (!body.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
    await getChatStore().renameConversation(user.sub, id, body.title.trim().slice(0, 120));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    const { id } = await params;
    await getChatStore().deleteConversation(user.sub, id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
