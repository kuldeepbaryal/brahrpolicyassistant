import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Unauthenticated liveness probe. */
export async function GET() {
  return NextResponse.json({ status: "ok", time: new Date().toISOString() });
}
