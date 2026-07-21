/**
 * Server-side auth:
 *  1. Google ID token verification (signature, aud, iss, exp) via
 *     google-auth-library, then a hard `hd === ALLOWED_HOSTED_DOMAIN` check.
 *  2. A short-lived signed session JWT in an HttpOnly cookie so we don't
 *     re-verify against Google certs on every request.
 *
 * The `hd` check here is the real gate — anything client-side is cosmetic.
 */
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { config, isMockMode } from "./config";
import { getUserStore } from "./db";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = "brac_hr_session";

const oauthClient = new OAuth2Client();

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_token" | "wrong_domain" | "no_session" = "invalid_token"
  ) {
    super(message);
  }
}

/**
 * Verify a Google ID token and enforce the hosted-domain restriction.
 * Throws AuthError on any failure.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  deps: { client?: Pick<OAuth2Client, "verifyIdToken"> } = {}
): Promise<SessionUser> {
  const client = deps.client ?? oauthClient;
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.oauthClientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AuthError("ID token verification failed", "invalid_token");
  }
  if (!payload || !payload.sub || !payload.email) {
    throw new AuthError("ID token missing required claims", "invalid_token");
  }
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new AuthError("Unexpected token issuer", "invalid_token");
  }
  // The gate: only the configured Workspace domain may enter. `hd` is absent
  // for consumer accounts, so this also rejects every gmail.com user.
  if (payload.hd !== config.allowedHostedDomain) {
    throw new AuthError(`Account is not in the ${config.allowedHostedDomain} domain`, "wrong_domain");
  }
  if (payload.email_verified === false) {
    throw new AuthError("Email not verified", "invalid_token");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    picture: payload.picture,
  };
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function createSessionJwt(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionHours}h`)
    .sign(secretKey());
}

export async function verifySessionJwt(token: string): Promise<SessionUser> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      name: String(payload.name ?? payload.email),
      picture: payload.picture ? String(payload.picture) : undefined,
    };
  } catch {
    throw new AuthError("Session invalid or expired", "no_session");
  }
}

export const MOCK_USER: SessionUser = {
  sub: "mock-user-000",
  email: "dev@brac.net",
  name: "Dev User (mock)",
};

/**
 * Resolve the authenticated user from a request's cookies.
 * In mock mode (never in production) a fake brac.net user is returned so the
 * UI can be exercised without Google credentials.
 */
export async function requireUser(cookieValue: string | undefined): Promise<SessionUser> {
  if (isMockMode()) return MOCK_USER;
  if (!cookieValue) throw new AuthError("Not signed in", "no_session");
  return verifySessionJwt(cookieValue);
}

/** True when the email is on the env allowlist (fallback, always counts). */
export function isAllowlistedAdmin(email: string): boolean {
  return config.adminEmails.includes(email.trim().toLowerCase());
}

/** Initial role for a first-time user record. */
export function initialRoleFor(email: string): "admin" | "user" {
  const e = email.trim().toLowerCase();
  return config.seedAdminEmails.includes(e) || isAllowlistedAdmin(e) ? "admin" : "user";
}

/**
 * Resolve admin status: DB user record role wins; the ADMIN_EMAILS env
 * allowlist always counts as a fallback (prevents lock-out if the table is
 * lost). Errors reading the user record fall back to the allowlist only.
 */
export async function isAdmin(user: Pick<SessionUser, "sub" | "email">): Promise<boolean> {
  if (isMockMode()) return true; // dev convenience
  if (isAllowlistedAdmin(user.email)) return true;
  try {
    const rec = await getUserStore().getUser(user.sub);
    if (rec) return rec.role === "admin";
    // No record yet (e.g. signed in before the users table existed) — seed list applies.
    return initialRoleFor(user.email) === "admin";
  } catch {
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: config.sessionHours * 3600,
  };
}
