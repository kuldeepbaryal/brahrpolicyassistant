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
  "contacting hrhelpdesk@brac.net. Never speculate or invent policy details. " +
  "Reply in the same language and script the user used: Bangla script for Bangla questions, Roman/Latin-script Bangla " +
  "(Banglish) for romanized Bangla questions, otherwise English. The policy documents are in English, so translate the " +
  "relevant policy content into the user's language; keep official terms, form names, and email addresses in English. " +
  "The RELATED follow-up questions must be in the same language and script as your answer. " +
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

const MAX_CITATIONS = 8;

/** Markdown link a chip renderer recognizes as an inline citation marker. */
export function citationMarker(n: number): string {
  return `[[${n}]](#cite-${n})`;
}

/**
 * Dedupe retrieved references into a citation list AND insert numbered
 * inline markers into the answer text. Bedrock reports, per citation, the
 * span of generated text (start/end offsets, end inclusive) that the
 * references support — markers are inserted right after each span, from the
 * end of the text backwards so earlier offsets stay valid. References past
 * the citation cap get no marker.
 */
export function extractCitationsWithMarkers(
  rawText: string,
  rawCitations: BedrockCitation[]
): { text: string; citations: Citation[] } {
  const seen = new Map<string, number>(); // dedupe key → index in `citations`
  const citations: Citation[] = [];
  const insertions: { pos: number; refIndexes: number[] }[] = [];

  for (const citation of rawCitations) {
    const refIndexes: number[] = [];
    for (const ref of citation.retrievedReferences ?? []) {
      const title =
        (ref.metadata?.["x-amz-bedrock-kb-source-uri"] as string | undefined)?.split("/").pop() ??
        "HR policy document";
      const uri =
        (ref.location?.s3Location?.uri as string | undefined) ??
        (ref.location?.webLocation?.url as string | undefined) ??
        "";
      const key = `${title}|${uri}`;
      let idx = seen.get(key);
      if (idx === undefined) {
        if (citations.length >= MAX_CITATIONS) continue;
        idx = citations.length;
        seen.set(key, idx);
        citations.push({ title, uri, snippet: (ref.content?.text ?? "").slice(0, 400) });
      }
      if (!refIndexes.includes(idx)) refIndexes.push(idx);
    }

    const end = citation.generatedResponsePart?.textResponsePart?.span?.end;
    if (refIndexes.length && typeof end === "number" && end >= 0) {
      insertions.push({ pos: Math.min(end + 1, rawText.length), refIndexes });
    }
  }

  let text = rawText;
  for (const ins of insertions.sort((a, b) => b.pos - a.pos)) {
    const markers = ins.refIndexes.map((i) => citationMarker(i + 1)).join(" ");
    text = `${text.slice(0, ins.pos)} ${markers}${text.slice(ins.pos)}`;
  }
  return { text, citations };
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
            // $output_format_instructions$ is required for Bedrock to attach
            // citations: it instructs the model to emit the citation markup
            // Bedrock parses into `citations[]`. Without it, answers come back
            // with no retrievedReferences at all.
            textPromptTemplate:
              ANSWER_PREAMBLE +
              "\n\n$output_format_instructions$\n\nSearch results:\n$search_results$\n\nUser question: $query$",
          },
        },
        // Required by models without a Bedrock-native RAG template (e.g. Kimi K2.5).
        orchestrationConfiguration: {
          promptTemplate: {
            textPromptTemplate:
              "Given the conversation below, rephrase the last user question into a standalone search query for an HR policy knowledge base. " +
              "The documents are in English, so always write the search query in English even if the question is in Bangla or romanized Bangla.\n" +
              "$conversation_history$\n" +
              "Question: $query$\n" +
              "$output_format_instructions$",
          },
        },
      },
    },
  });

  const res = await getClient().send(command);
  const marked = extractCitationsWithMarkers(res.output?.text ?? "", res.citations ?? []);
  const { answerText, relatedQuestions } = splitRelated(marked.text);
  const citations = marked.citations;
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
  const trimmed = raw.trimEnd();
  // Only treat a STRICTLY trailing "RELATED: ..." line as suggestions —
  // a "related:" mention mid-answer must never be stripped from the body.
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastLine = trimmed.slice(lastNewline + 1).trim();
  const match = lastLine.match(/^RELATED:\s*(.+)$/i);
  if (!match) return { answerText: raw.trim(), relatedQuestions: [] };
  const relatedQuestions = match[1]
    .split("|")
    .map((q) => q.trim().replace(/^[-•\d.\s]+/, ""))
    .filter((q) => q.length > 3 && q.length <= 160)
    .slice(0, 3);
  const answerText = (lastNewline === -1 ? "" : trimmed.slice(0, lastNewline)).trim();
  // If the model ONLY output a RELATED line, keep the raw text as the answer.
  if (!answerText) return { answerText: raw.trim(), relatedQuestions: [] };
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
    ((key && MOCK_ANSWERS[key]) ??
      `Here is what BRAC's HR policies say:\n\n- This is a **mock answer** (MOCK_MODE is on).\n- In production, answers come from your Bedrock Knowledge Base.\n- Your question was: _"${question}"_`) +
    ` ${citationMarker(1)}`;
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
