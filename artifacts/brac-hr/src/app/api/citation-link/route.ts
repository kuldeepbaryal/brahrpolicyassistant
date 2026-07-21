import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESSION_COOKIE, requireUser } from "@/lib/auth";
import { config, isMockMode } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: config.awsRegion,
      ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
    });
  }
  return _s3;
}

/**
 * GET /api/citation-link?uri=s3://bucket/key — redirect a signed-in user to a
 * short-lived signed URL for a cited policy document. Only s3:// URIs are
 * accepted; anything else is rejected (public http(s) citation links are used
 * directly by the client and never routed here).
 */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const uri = req.nextUrl.searchParams.get("uri") ?? "";
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const [, bucket, key] = match;

  // Default deny: only sign objects in the configured policy-document
  // bucket(s) so a signed-in user cannot mint links for arbitrary S3 objects
  // the app's AWS identity can read.
  if (!config.citationDocBuckets.includes(bucket)) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "This document bucket is not allowed. Set CITATION_DOC_BUCKETS to the Knowledge Base document bucket name.",
      },
      { status: 403 }
    );
  }

  if (isMockMode()) {
    // Dev without AWS: nothing to sign — send the user somewhere harmless.
    return NextResponse.json(
      { error: "not_available", message: "Document links are not available in mock mode." },
      { status: 404 }
    );
  }

  try {
    const url = await getSignedUrl(getS3(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: 300, // 5 minutes — long enough to open, short enough not to share
    });
    return NextResponse.redirect(url, 302);
  } catch {
    // The app's AWS identity needs s3:GetObject on the policy documents bucket.
    return NextResponse.json(
      { error: "server_error", message: "Could not create a link to this document." },
      { status: 500 }
    );
  }
}
