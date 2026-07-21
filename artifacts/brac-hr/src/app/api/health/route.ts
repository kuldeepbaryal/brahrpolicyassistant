import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    env: {
      APP_AWS_KEY: !!process.env.APP_AWS_KEY,
      APP_AWS_SECRET: !!process.env.APP_AWS_SECRET,
      BEDROCK_KB_ID: !!process.env.BEDROCK_KB_ID,
      GOOGLE_OAUTH_CLIENT_ID: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      SESSION_SECRET: !!process.env.SESSION_SECRET,
      AWS_REGION: process.env.AWS_REGION || "(not set)",
      NODE_ENV: process.env.NODE_ENV,
      MOCK_MODE: process.env.MOCK_MODE || "(not set)",
      // Show first 8 chars of key to confirm it's the right one
      APP_AWS_KEY_HINT: process.env.APP_AWS_KEY
        ? process.env.APP_AWS_KEY.slice(0, 8) + "..."
        : "(missing)",
    },
  });
}
