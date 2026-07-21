import { NextRequest, NextResponse } from "next/server";
import {
  AuthError,
  SESSION_COOKIE,
  createSessionJwt,
  requireUser,
  sessionCookieOptions,
  verifyGoogleIdToken,
} from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isMockMode } from "@/lib/config";
import { hashUser, log } from "@/lib/logger";

export const runtime = "nodejs";

/** Exchange a Google ID token for our signed session cookie. */
export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const { credential } = (await req.json().catch(() => ({}))) as { credential?: string };
  if (!credential && !isMockMode()) {
    return NextResponse.json({ error: "missing credential" }, { status: 400 });
  }
  try {
    const user = isMockMode()
      ? await requireUser(undefined) // mock user
      : await verifyGoogleIdToken(credential!);
    const jwt = await createSessionJwt(user);
    log.info("sign-in", { user: hashUser(user.sub) });
    const res = NextResponse.json({ user: { email: user.email, name: user.name, picture: user.picture } });
    res.cookies.set(SESSION_COOKIE, jwt, sessionCookieOptions());
    return res;
  } catch (err) {
    if (err instanceof AuthError && err.code === "wrong_domain") {
      log.warn("sign-in rejected: wrong domain");
      return NextResponse.json(
        { error: "wrong_domain", message: "This app is only available to BRAC staff (brac.net accounts)." },
        { status: 403 }
      );
    }
    log.warn("sign-in rejected: invalid token");
    return NextResponse.json({ error: "invalid_token", message: "Sign-in failed. Please try again." }, { status: 401 });
  }
}

/** Current user, if any. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({ user: { email: user.email, name: user.name, picture: user.picture } });
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}

/** Sign out. */
export async function DELETE(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
