import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal liveness check — no configuration or backend details exposed. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
