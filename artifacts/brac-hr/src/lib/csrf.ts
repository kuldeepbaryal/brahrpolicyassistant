/**
 * CSRF defence for state-changing routes. The session cookie is SameSite=Lax,
 * which already blocks cross-site POSTs in modern browsers; this adds an
 * explicit same-origin check (Sec-Fetch-Site when present, else Origin) as
 * defence in depth.
 */
export function assertSameOrigin(req: Request): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client (e.g. curl in dev/tests)
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return originHost === reqHost;
  } catch {
    return false;
  }
}
