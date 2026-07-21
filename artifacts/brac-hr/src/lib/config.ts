/**
 * All runtime configuration. Nothing is hardcoded elsewhere — import from
 * this module only.
 *
 * AWS deployment:
 *   - Credentials are picked up automatically from the Lambda execution role
 *     (Amplify) or from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for local dev.
 *   - Required env vars: GOOGLE_OAUTH_CLIENT_ID, SESSION_SECRET,
 *     AWS_BEDROCK_KB_ID
 *   - Optional: AWS_REGION (default us-east-1), AWS_BEDROCK_MODEL_ARN,
 *     DYNAMO_TABLE_PREFIX (default BracHR), ALLOWED_HOSTED_DOMAIN,
 *     RATE_LIMIT_PER_HOUR, SESSION_HOURS, ANSWER_CACHE_TTL_SECONDS
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v && !isMockMode()) throw new Error(`Missing required env var: ${name}`);
  return v ?? "";
}

export function isMockMode(): boolean {
  return process.env.MOCK_MODE === "true" && process.env.NODE_ENV !== "production";
}

export const config = {
  // ── AWS ──────────────────────────────────────────────────────────────────
  // AWS_REGION is injected automatically by Lambda/Amplify at runtime.
  // We read it directly; no need to set it as a custom env var.
  get awsRegion() {
    return process.env.AWS_REGION || process.env.BEDROCK_REGION || "ap-south-1";
  },
  // Explicit credentials for Amplify SSR compute (which has no IAM execution
  // role). Set APP_AWS_KEY + APP_AWS_SECRET as Amplify env vars.
  // When both are absent the SDK falls back to its default credential chain
  // (works on Lambda / local dev with ~/.aws/credentials).
  get awsCredentials() {
    const key = process.env.APP_AWS_KEY;
    const secret = process.env.APP_AWS_SECRET;
    if (key && secret) return { accessKeyId: key, secretAccessKey: secret };
    return undefined; // let the SDK resolve credentials automatically
  },
  /** Bedrock Knowledge Base ID (required in production). */
  get bedrockKbId() {
    return req("BEDROCK_KB_ID");
  },
  /** Full model ARN for Bedrock Knowledge Base generation. */
  get bedrockModelArn() {
    return (
      process.env.BEDROCK_MODEL_ARN ||
      // Kimi K2.5 (Moonshot AI): user-selected model, verified accessible
      // on-demand in ap-south-1. Requires custom generation + orchestration
      // prompt templates (set in discovery.ts).
      `arn:aws:bedrock:${this.awsRegion}::foundation-model/moonshotai.kimi-k2.5`
    );
  },
  /** DynamoDB table name prefix — tables are e.g. BracHRConversations. */
  get dynamoTablePrefix() {
    return process.env.DYNAMO_TABLE_PREFIX || "BracHR";
  },

  // ── Auth ─────────────────────────────────────────────────────────────────
  get oauthClientId() {
    return req("GOOGLE_OAUTH_CLIENT_ID");
  },
  get allowedHostedDomain() {
    return process.env.ALLOWED_HOSTED_DOMAIN || "brac.net";
  },
  get sessionSecret() {
    const s = req("SESSION_SECRET");
    if (!s && isMockMode()) return "mock-mode-dev-secret-do-not-use-in-prod";
    return s;
  },
  /** Comma-separated list of HR admin emails allowed to view /admin. */
  get adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  get sessionHours() {
    return Number(process.env.SESSION_HOURS || 8);
  },

  // ── Limits / cache ────────────────────────────────────────────────────────
  get rateLimitPerHour() {
    return Number(process.env.RATE_LIMIT_PER_HOUR || 30);
  },
  get answerCacheTtlSeconds() {
    return Number(process.env.ANSWER_CACHE_TTL_SECONDS || 3600);
  },
};
