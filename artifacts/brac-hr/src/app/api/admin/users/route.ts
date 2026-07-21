import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { StorageError } from "@/lib/db";
import { getRoleService } from "@/lib/roles";
import { log, hashUser } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(req: NextRequest) {
  const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!(await isAdmin(user))) return { user, ok: false as const };
  return { user, ok: true as const };
}

function errorResponse(err: unknown) {
  const code = err instanceof StorageError ? err.code : "unavailable";
  log.error("admin users failed", {
    errorClass:
      code === "permission_denied" ? "access_denied" : code === "not_provisioned" ? "missing_table" : "api_error",
  });
  return NextResponse.json(
    {
      error: "server_error",
      message:
        code === "permission_denied"
          ? "The app's storage permissions don't cover the Users table yet."
          : code === "not_provisioned"
            ? "The Users table doesn't exist yet."
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
    const users = await getRoleService().listUsers();
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
    // All role rules (last-admin guard, concurrency revert, audit) live in
    // the role module — this route only translates the result to HTTP.
    const result = await getRoleService().changeRole(
      { sub: gate.user.sub, email: gate.user.email, name: gate.user.name },
      body.sub,
      body.role
    );
    if (!result.ok) {
      if (result.error === "not_found") {
        return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
      }
      return NextResponse.json(
        { error: "last_admin", message: "You can't remove the last remaining admin." },
        { status: result.reverted ? 409 : 400 }
      );
    }
    if (result.changed) {
      log.info("role change", { by: hashUser(gate.user.sub), target: hashUser(body.sub), role: body.role });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
