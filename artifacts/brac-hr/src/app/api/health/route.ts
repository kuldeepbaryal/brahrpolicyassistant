import { NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
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

  // DynamoDB self-test: run the same Query the app runs (the IAM policy only
  // grants data-plane actions, so DescribeTable would always be denied).
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: config.awsRegion,
      ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
    })
  );
  const p = config.dynamoTablePrefix;
  let dynamo: string;
  try {
    const res = await client.send(
      new QueryCommand({
        TableName: `${p}Conversations`,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": "healthcheck" },
      })
    );
    dynamo = `QUERY OK (items: ${res.Count ?? 0})`;
  } catch (err) {
    dynamo = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return NextResponse.json({ ok: true, env, region: config.awsRegion, tablePrefix: p, dynamo });
}
