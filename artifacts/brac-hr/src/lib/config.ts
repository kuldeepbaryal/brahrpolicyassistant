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
      // Claude Opus 4.6 via the global cross-region inference profile (the
      // only Opus 4.6 profile that routes from ap-south-1). Inference-profile
      // ARNs are account-scoped, hence the account ID.
      `arn:aws:bedrock:${this.awsRegion}:953934431385:inference-profile/global.anthropic.claude-opus-4-6-v1`
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
  /** Comma-separated list of HR admin emails allowed to view /admin (fallback allowlist). */
  get adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * Emails seeded as admin the first time they sign in. Once the user record
   * exists, the role is managed from the admin Users page (DB wins).
   */
  get seedAdminEmails(): string[] {
    return ["kuldeep.aryal@brac.net"];
  },
  get sessionHours() {
    return Number(process.env.SESSION_HOURS || 8);
  },

  // ── Limits / cache ────────────────────────────────────────────────────────
  get rateLimitPerHour() {
    return Number(process.env.RATE_LIMIT_PER_HOUR || 30);
  },
  get answerCacheTtlSeconds() {
    // 6 hours: HR policy answers are stable, and a longer TTL keeps popular
    // first-turn questions off Bedrock during traffic spikes.
    return Number(process.env.ANSWER_CACHE_TTL_SECONDS || 21600);
  },

  /**
   * S3 buckets that citation "Open" links may be signed for — the Knowledge
   * Base document bucket(s). Comma-separated. Empty means the citation-link
   * endpoint refuses to sign anything (default deny).
   */
  get citationDocBuckets(): string[] {
    return (process.env.CITATION_DOC_BUCKETS ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
  },
};
