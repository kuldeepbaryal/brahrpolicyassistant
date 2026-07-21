import { NextResponse } from "next/server";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { config } from "@/lib/config";

export const runtime = "nodejs";

// TEMPORARY diagnostic route — remove before go-live.
export async function GET() {
  const env = {
    APP_AWS_KEY: !!process.env.APP_AWS_KEY,
    APP_AWS_SECRET: !!process.env.APP_AWS_SECRET,
    BEDROCK_KB_ID: !!process.env.BEDROCK_KB_ID,
    GOOGLE_OAUTH_CLIENT_ID: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
    AWS_REGION: process.env.AWS_REGION || "(not set)",
    NODE_ENV: process.env.NODE_ENV,
    MOCK_MODE: process.env.MOCK_MODE || "(not set)",
  };

  // DynamoDB self-test: check each table the app needs.
  const client = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
  });
  const p = config.dynamoTablePrefix;
  const tables = [`${p}Conversations`, `${p}Messages`, `${p}Feedback`, `${p}AnswerCache`, `${p}RateLimits`];
  const dynamo: Record<string, string> = {};
  for (const t of tables) {
    try {
      const res = await client.send(new DescribeTableCommand({ TableName: t }));
      dynamo[t] = res.Table?.TableStatus ?? "UNKNOWN";
    } catch (err) {
      dynamo[t] = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  return NextResponse.json({ ok: true, env, region: config.awsRegion, tablePrefix: p, dynamo });
}
