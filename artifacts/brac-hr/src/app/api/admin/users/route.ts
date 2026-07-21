import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin, isAllowlistedAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { getDb } from "@/lib/db";
import { log, hashUser } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(req: NextRequest) {
  const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!(await isAdmin(user))) return { user, ok: false as const };
  return { user, ok: true as const };
}

function errorResponse(err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  const isAccessDenied = /AccessDenied/i.test(detail);
  const isMissingTable = /ResourceNotFound/i.test(detail);
  log.error("admin users failed", {
    errorClass: isAccessDenied ? "access_denied" : isMissingTable ? "missing_table" : "api_error",
  });
  return NextResponse.json(
    {
      error: "server_error",
      message: isAccessDenied
        ? "The app's AWS permissions don't cover the Users table yet."
        : isMissingTable
          ? "The Users table doesn't exist yet in DynamoDB."
          : "Failed to load users. Please try again.",
    },
    { status: 500 }
  );
}

/** GET /api/admin/users — list all users who have signed in. */
export async function GET(req: NextRequest) {
  let gate;
  try {
    gate = await requireAdmin(req);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const users = await getDb().listUsers();
    return NextResponse.json({
      me: gate.user.sub,
      users: users.map((u) => ({
        sub: u.sub,
        email: u.email,
        name: u.name,
        role: u.role,
        lastSignInAt: u.lastSignInAt,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/admin/users — { sub, role } toggle a user's role. */
export async function PATCH(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  let gate;
  try {
    gate = await requireAdmin(req);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { sub?: string; role?: string };
  if (!body.sub || (body.role !== "admin" && body.role !== "user")) {
    return NextResponse.json({ error: "bad_request", message: "sub and role (admin|user) required" }, { status: 400 });
  }

  try {
    const db = getDb();
    const users = await db.listUsers();
    const target = users.find((u) => u.sub === body.sub);
    if (!target) {
      return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
    }
    // Lock-out guard: never demote the last remaining admin (env-allowlisted
    // admins don't count here since they can't be managed from this page).
    if (target.role === "admin" && body.role === "user") {
      const adminCount = users.filter((u) => u.role === "admin").length;
      if (adminCount <= 1 && !isAllowlistedAdmin(target.email)) {
        return NextResponse.json(
          { error: "last_admin", message: "You can't remove the last remaining admin." },
          { status: 400 }
        );
      }
    }
    if (target.role === body.role) {
      // No-op: role already set — nothing to change or audit.
      return NextResponse.json({ ok: true });
    }
    const auditFor = (fromRole: "admin" | "user", toRole: "admin" | "user") => ({
      actorSub: gate.user.sub,
      actorEmail: gate.user.email ?? "",
      actorName: gate.user.name ?? "",
      targetSub: target.sub,
      targetEmail: target.email,
      targetName: target.name,
      fromRole,
      toRole,
      createdAt: Date.now(),
    });
    // Atomic: role update + audit event persist together, or neither does.
    await db.changeUserRole(body.sub, body.role, auditFor(target.role, body.role));
    // Concurrency guard: two simultaneous demotions could both pass the
    // pre-check above. Re-verify after the write and revert (also audited)
    // if the table was left with no admins at all.
    if (target.role === "admin" && body.role === "user") {
      const after = await db.listUsers();
      if (!after.some((u) => u.role === "admin")) {
        await db.changeUserRole(body.sub, "admin", auditFor("user", "admin"));
        return NextResponse.json(
          { error: "last_admin", message: "You can't remove the last remaining admin." },
          { status: 409 }
        );
      }
    }
    log.info("role change", { by: hashUser(gate.user.sub), target: hashUser(body.sub), role: body.role });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
