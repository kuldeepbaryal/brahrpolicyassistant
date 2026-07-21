import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin } from "@/lib/auth";
import { getUserStore, StorageError } from "@/lib/db";
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
    const changes = await getUserStore().listRoleChanges(100);
    return NextResponse.json({ changes });
  } catch (err) {
    log.error("role changes list failed", {
      errorClass: err instanceof StorageError && err.code === "permission_denied" ? "access_denied" : "api_error",
    });
    return NextResponse.json(
      { error: "server_error", message: "Failed to load role change history. Please try again." },
      { status: 500 }
    );
  }
}
