import type { NextConfig } from "next";

// Next.js dev mode evaluates its module runtime via eval(); production builds
// do not, so 'unsafe-eval' is scoped to development only.
const scriptSrc =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com"
    : "script-src 'self' 'unsafe-inline' https://accounts.google.com";

const csp = [
  "default-src 'self'",
  // GIS button script + inline bootstrap
  scriptSrc,
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "connect-src 'self' https://accounts.google.com",
  "img-src 'self' data: https://*.googleusercontent.com",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Allow the Replit preview proxy to load /_next/* assets in dev mode.
// Next.js 15 blocks cross-origin requests to /_next/* by default.
const allowedDevOrigins = [
  "*.replit.dev",
  "*.sisko.replit.dev",
  "*.repl.co",
  ...(process.env.REPLIT_DEV_DOMAIN ? [process.env.REPLIT_DEV_DOMAIN] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
