/**
 * AWS Bedrock Knowledge Bases client.
 *
 * Uses the RetrieveAndGenerate API to answer questions grounded in the
 * configured Bedrock Knowledge Base (your indexed HR policy documents).
 *
 * Required env vars:
 *   AWS_BEDROCK_KB_ID      — Knowledge Base ID from the Bedrock console
 *   AWS_REGION             — e.g. us-east-1 (default)
 *   AWS_BEDROCK_MODEL_ARN  — optional; defaults to Claude 3 Sonnet
 *
 * Credentials:
 *   • Amplify/Lambda  → execution role (no env vars needed)
 *   • Local dev       → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env.local
 */
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  type Citation as BedrockCitation,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { config, isMockMode } from "./config";
import { log } from "./logger";
import type { AnswerResult, Citation } from "./types";

const ANSWER_PREAMBLE =
  "You are BRAC's internal HR policy assistant. Answer ONLY using the retrieved BRAC HR policy documents. " +
  "If the documents do not contain the answer, say you could not find it in BRAC's HR policies and suggest " +
  "contacting hr@brac.net. Never speculate or invent policy details. " +
  "Format answers with Markdown (short paragraphs, bullet lists for steps or entitlements). " +
  "After your answer, on the very last line, output exactly: RELATED: followed by 3 short follow-up questions " +
  "an employee might ask next, separated by ' | '. If you could not find an answer, omit the RELATED line.";

function makeClient(): BedrockAgentRuntimeClient {
  return new BedrockAgentRuntimeClient({
    region: config.awsRegion,
    ...(config.awsCredentials ? { credentials: config.awsCredentials } : {}),
  });
}

// Lazy singleton — initialised on first request so the region/model config
// is read after env vars are loaded.
let _client: BedrockAgentRuntimeClient | null = null;
function getClient(): BedrockAgentRuntimeClient {
  if (!_client) _client = makeClient();
  return _client;
}

export class QuotaError extends Error {}
export class DiscoveryError extends Error {}

/**
 * For Bedrock Knowledge Bases there is no separate session-creation step —
 * the session ID is returned from the first RetrieveAndGenerate call and
 * stored on the conversation for use in subsequent turns.
 */
export async function createEngineSession(_userPseudoId: string): Promise<string | null> {
  if (isMockMode()) return `mock-session/${_userPseudoId}/${Date.now()}`;
  return null; // Bedrock creates the session on the first answerQuery call.
}

function extractCitations(rawCitations: BedrockCitation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of rawCitations) {
    for (const ref of citation.retrievedReferences ?? []) {
      const title =
        (ref.metadata?.["x-amz-bedrock-kb-source-uri"] as string | undefined)?.split("/").pop() ??
        "HR policy document";
      const uri =
        (ref.location?.s3Location?.uri as string | undefined) ??
        (ref.location?.webLocation?.url as string | undefined) ??
        "";
      const snippet = (ref.content?.text ?? "").slice(0, 400);
      const key = `${title}|${uri}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, uri, snippet });
    }
  }
  return out.slice(0, 8);
}

export async function answerQuery(
  question: string,
  opts: { sessionName?: string | null; userPseudoId: string }
): Promise<AnswerResult> {
  if (isMockMode()) return mockAnswer(question, opts.sessionName ?? null);

  const started = Date.now();
  try {
    return await runQuery(question, opts.sessionName ?? null, started);
  } catch (err: unknown) {
    // Bedrock rejects the entire call when given an expired/invalid sessionId
    // (e.g. stored on an old conversation). Retry once without the session.
    const name = (err as { name?: string }).name ?? "";
    const msg = (err as Error).message ?? "";
    const sessionProblem =
      opts.sessionName && (name === "ResourceNotFoundException" || (name === "ValidationException" && /session/i.test(msg)));
    if (sessionProblem) {
      log.warn("answerQuery: stale Bedrock session, retrying without session");
      try {
        return await runQuery(question, null, started);
      } catch (retryErr) {
        throw mapError(retryErr, started);
      }
    }
    throw mapError(err, started);
  }
}

function mapError(err: unknown, started: number): Error {
  const name = (err as { name?: string }).name ?? "";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") {
    return new QuotaError("Bedrock quota exceeded");
  }
  log.error("answerQuery failed", { latencyMs: Date.now() - started });
  return new DiscoveryError(`Bedrock error: ${(err as Error).message}`);
}

// Throws the raw AWS error so the caller can inspect it (session retry, quota mapping).
async function runQuery(question: string, sessionName: string | null, started: number): Promise<AnswerResult> {
  const command = new RetrieveAndGenerateCommand({
      ...(sessionName ? { sessionId: sessionName } : {}),
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE",
      knowledgeBaseConfiguration: {
        knowledgeBaseId: config.bedrockKbId,
        modelArn: config.bedrockModelArn,
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate:
              ANSWER_PREAMBLE +
              "\n\nSearch results:\n$search_results$\n\nUser question: $query$",
          },
        },
        // Required by models without a Bedrock-native RAG template (e.g. Kimi K2.5).
        orchestrationConfiguration: {
          promptTemplate: {
            textPromptTemplate:
              "Given the conversation below, rephrase the last user question into a standalone search query for an HR policy knowledge base.\n" +
              "$conversation_history$\n" +
              "Question: $query$\n" +
              "$output_format_instructions$",
          },
        },
      },
    },
  });

  const res = await getClient().send(command);
  const { answerText, relatedQuestions } = splitRelated(res.output?.text ?? "");
  const citations = extractCitations(res.citations ?? []);
  const noResults = !answerText.trim();

  log.info("answerQuery ok", { latencyMs: Date.now() - started, noResults, citations: citations.length });

  return {
    answerText,
    citations,
    relatedQuestions,
    sessionName: res.sessionId ?? sessionName ?? null,
    noResults,
  };
}

/**
 * The generation prompt asks the model to append a final "RELATED: q1 | q2 | q3"
 * line. Strip it from the answer and surface the questions separately. Models
 * sometimes omit the line — degrade to no suggestions.
 */
function splitRelated(raw: string): { answerText: string; relatedQuestions: string[] } {
  const match = raw.match(/^\s*RELATED:\s*(.+?)\s*$/im);
  if (!match) return { answerText: raw.trim(), relatedQuestions: [] };
  const relatedQuestions = match[1]
    .split("|")
    .map((q) => q.trim().replace(/^[-•\d.\s]+/, ""))
    .filter((q) => q.length > 3 && q.length <= 160)
    .slice(0, 3);
  const answerText = raw.replace(match[0], "").trim();
  return { answerText, relatedQuestions };
}

/* ─────────────────────────── mock answers (dev) ──────────────────────── */

const MOCK_ANSWERS: Record<string, string> = {
  leave:
    "### Annual leave at BRAC\n\nRegular full-time staff are entitled to **20 working days of annual leave** per calendar year, accrued monthly.\n\n- Leave must be requested through the HRIS at least **7 days in advance**.\n- Up to **10 unused days** may be carried into the next year.",
  maternity:
    "### Maternity leave policy\n\nBRAC provides **26 weeks (182 days) of fully paid maternity leave** for all female staff.\n\n1. Notify HR in writing at least **8 weeks** before the expected delivery date.\n2. On return, nursing mothers are entitled to **two 30-minute nursing breaks** per day for 6 months.",
  probation:
    "### Probation period\n\nNew regular staff serve a **6-month probation period**.\n\n- A mid-point check-in happens at 3 months.\n- Either party may end employment with **2 weeks' notice** during probation.",
};

function mockAnswer(question: string, sessionName: string | null): AnswerResult {
  const q = question.toLowerCase();
  const key = ["maternity", "probation", "leave"].find((k) => q.includes(k));
  const answerText =
    (key && MOCK_ANSWERS[key]) ??
    `Here is what BRAC's HR policies say:\n\n- This is a **mock answer** (MOCK_MODE is on).\n- In production, answers come from your Bedrock Knowledge Base.\n- Your question was: _"${question}"_`;
  return {
    answerText,
    citations: [
      {
        title: "BRAC HR Policy Manual 2025",
        uri: "s3://brac-hr-policies/hr-policy-manual-2025.pdf",
        snippet: "Section 4.2 sets out leave entitlements for regular full-time staff…",
      },
    ],
    relatedQuestions: ["How do I apply for annual leave?", "What is the sick leave policy?"],
    sessionName: sessionName ?? `mock-session/${Date.now()}`,
    noResults: false,
  };
}
