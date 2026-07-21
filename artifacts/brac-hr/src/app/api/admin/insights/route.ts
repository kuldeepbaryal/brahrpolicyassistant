import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requireUser, isAdmin } from "@/lib/auth";
import { StorageError } from "@/lib/db";
import { getAdminInsights } from "@/lib/insights";
import { log, hashUser } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type { AdminInsights } from "@/lib/insights";

/** GET /api/admin/insights?days=7|30|90 — HR admin dashboard data. */
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

  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
  // Window = the last N UTC calendar days including today, starting at day
  // boundary. This matches the day granularity of the pre-aggregated stats
  // partitions, so counters and event lists share exactly the same window.
  const now = new Date();
  const since =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (days - 1) * 24 * 3600 * 1000;

  try {
    const { insights, source } = await getAdminInsights(days, since);
    log.info("admin insights", { user: hashUser(user.sub), days, source });
    return NextResponse.json(insights);
  } catch (err) {
    // The app's storage identity must be able to read the DailyStats data
    // (and scan Messages/Feedback for the legacy fallback) for this endpoint
    // to work in production.
    const isAccessDenied = err instanceof StorageError && err.code === "permission_denied";
    log.error("admin insights failed", { errorClass: isAccessDenied ? "access_denied" : "api_error" });
    return NextResponse.json(
      {
        error: "server_error",
        message: isAccessDenied
          ? "The app's storage permissions are missing reads on the stats data (and scans on Messages/Feedback) needed for the dashboard."
          : "Failed to load insights. Please try again.",
      },
      { status: 500 }
    );
  }
}
