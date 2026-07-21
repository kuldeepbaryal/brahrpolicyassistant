import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/role-changes — audit trail of admin role changes, newest first. */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isAdmin(user))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const changes = await getDb().listRoleChanges(100);
    return NextResponse.json({ changes });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("role changes list failed", {
      errorClass: /AccessDenied/i.test(detail) ? "access_denied" : "api_error",
    });
    return NextResponse.json(
      { error: "server_error", message: "Failed to load role change history. Please try again." },
      { status: 500 }
    );
  }
}
