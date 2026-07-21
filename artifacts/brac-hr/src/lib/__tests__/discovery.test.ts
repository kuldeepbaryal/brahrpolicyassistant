import { describe, expect, it } from "vitest";
import { citationMarker, extractCitationsWithMarkers } from "../discovery";

process.env.MOCK_MODE = "true";

type RawCitation = Parameters<typeof extractCitationsWithMarkers>[1][number];

function ref(uri: string, title = uri.split("/").pop()!, text = "snippet") {
  return {
    location: { s3Location: { uri } },
    metadata: { "x-amz-bedrock-kb-source-uri": uri },
    content: { text },
  };
}

function cite(span: { start: number; end: number } | null, ...refs: unknown[]): RawCitation {
  return {
    ...(span ? { generatedResponsePart: { textResponsePart: { span } } } : {}),
    retrievedReferences: refs,
  } as RawCitation;
}

describe("extractCitationsWithMarkers", () => {
  it("returns text unchanged with no citations", () => {
    const { text, citations } = extractCitationsWithMarkers("Hello world.", []);
    expect(text).toBe("Hello world.");
    expect(citations).toEqual([]);
  });

  it("inserts a numbered marker right after the supported span", () => {
    const raw = "Staff get 20 days. Probation is 6 months.";
    const { text, citations } = extractCitationsWithMarkers(raw, [
      cite({ start: 0, end: 17 }, ref("s3://b/leave.pdf")),
    ]);
    expect(text).toBe(`Staff get 20 days. ${citationMarker(1)} Probation is 6 months.`);
    expect(citations).toEqual([{ title: "leave.pdf", uri: "s3://b/leave.pdf", snippet: "snippet" }]);
  });

  it("keeps earlier offsets valid when inserting multiple markers (back to front)", () => {
    const raw = "AAAA. BBBB.";
    const { text } = extractCitationsWithMarkers(raw, [
      cite({ start: 0, end: 4 }, ref("s3://b/one.pdf")),
      cite({ start: 6, end: 10 }, ref("s3://b/two.pdf")),
    ]);
    expect(text).toBe(`AAAA. ${citationMarker(1)} BBBB. ${citationMarker(2)}`);
  });

  it("dedupes repeated references to the same document and reuses the number", () => {
    const raw = "First. Second.";
    const { text, citations } = extractCitationsWithMarkers(raw, [
      cite({ start: 0, end: 5 }, ref("s3://b/policy.pdf")),
      cite({ start: 7, end: 13 }, ref("s3://b/policy.pdf")),
    ]);
    expect(citations).toHaveLength(1);
    expect(text).toContain(`First. ${citationMarker(1)}`);
    expect(text.endsWith(citationMarker(1))).toBe(true);
  });

  it("joins multiple references supporting the same span", () => {
    const { text, citations } = extractCitationsWithMarkers("Fact.", [
      cite({ start: 0, end: 4 }, ref("s3://b/a.pdf"), ref("s3://b/b.pdf")),
    ]);
    expect(citations).toHaveLength(2);
    expect(text).toBe(`Fact. ${citationMarker(1)} ${citationMarker(2)}`);
  });

  it("clamps out-of-range spans to the end of the text", () => {
    const { text } = extractCitationsWithMarkers("Short.", [
      cite({ start: 0, end: 9999 }, ref("s3://b/a.pdf")),
    ]);
    expect(text).toBe(`Short. ${citationMarker(1)}`);
  });

  it("collects citations without a span but inserts no marker", () => {
    const { text, citations } = extractCitationsWithMarkers("Plain.", [
      cite(null, ref("s3://b/a.pdf")),
    ]);
    expect(text).toBe("Plain.");
    expect(citations).toHaveLength(1);
  });

  it("caps the citation list at 8 and skips markers for overflow references", () => {
    const refs = Array.from({ length: 10 }, (_, i) => ref(`s3://b/doc${i}.pdf`));
    const { text, citations } = extractCitationsWithMarkers("X.", [cite({ start: 0, end: 1 }, ...refs)]);
    expect(citations).toHaveLength(8);
    expect(text).toContain(citationMarker(8));
    expect(text).not.toContain("[[9]]");
  });
});
