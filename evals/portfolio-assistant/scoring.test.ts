import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  conflictSurfaced,
  evidenceRecall,
  forbiddenClaimHits,
  normalizeText,
  outcomeCorrect,
  parseDataset,
  requiredFactsMet,
  summarize,
  type EvalItem,
  type EvalResult
} from "./scoring";

const here = path.dirname(new URL(import.meta.url).pathname);

function item(overrides: Partial<EvalItem> = {}): EvalItem {
  return {
    id: "t-001",
    category: "single_fact",
    question: "Which payment gateways were integrated?",
    expected_outcome: "answered",
    evidence: [
      { source: "backend", text: "Stripe and PayPal" },
      { source: "senior", text: "135+ currencies" }
    ],
    required_facts: [["stripe"], ["paypal"]],
    forbidden_claims: ["\\$200k", "1,?800 users"],
    ...overrides
  };
}

const sourcePatterns = { backend: "backend", senior: "sr_software_engineer|sr software engineer" };

describe("dataset.v1.jsonl", () => {
  const items = parseDataset(readFileSync(path.join(here, "dataset.v1.jsonl"), "utf8"));

  it("has the planned category mix", () => {
    const counts = Object.fromEntries(
      [...new Set(items.map((i) => i.category))].map((category) => [category, items.filter((i) => i.category === category).length])
    );
    expect(items).toHaveLength(60);
    expect(counts).toEqual({
      single_fact: 24,
      synthesis: 8,
      abstention: 10,
      claim_safety: 6,
      adversarial: 6,
      conflicting_sources: 6
    });
  });

  it("only uses sources mapped in documents.json", () => {
    const documents = JSON.parse(readFileSync(path.join(here, "documents.json"), "utf8")) as Record<string, string>;
    const used = new Set(items.flatMap((i) => i.evidence.map((e) => e.source)));
    for (const source of used) expect(documents).toHaveProperty(source);
  });

  it("never expects a plain answer to a question the knowledge base cannot answer", () => {
    for (const i of items.filter((x) => x.category === "abstention")) {
      expect(i.expected_outcome, i.id).not.toBe("answered");
      if (i.expected_outcome === "either") expect(i.forbidden_claims.length, i.id).toBeGreaterThan(0);
    }
  });

  it("guards the Museum Advocate claim-safety rules somewhere in the set", () => {
    const forbidden = items.flatMap((i) => i.forbidden_claims).join("\n");
    expect(forbidden).toMatch(/1,\?800|1800|1,800/);
    expect(forbidden).toMatch(/200/);
  });
});

describe("parseDataset", () => {
  it("rejects duplicate ids", () => {
    const line = JSON.stringify(item());
    expect(() => parseDataset(`${line}\n${line}`)).toThrow(/Duplicate eval id/);
  });

  it("rejects answerable items without evidence", () => {
    expect(() => parseDataset(JSON.stringify(item({ evidence: [] })))).toThrow(/no evidence/);
  });

  it("rejects invalid regexes", () => {
    expect(() => parseDataset(JSON.stringify(item({ forbidden_claims: ["(unclosed"] })))).toThrow();
  });
});

describe("evidenceRecall", () => {
  it("matches evidence phrases across chunk boundaries of whitespace, case and dashes", () => {
    const result = evidenceRecall(
      item(),
      [{ documentName: "Tehseen Ahmed Resume - Senior Backend Engineer", text: "Integrated STRIPE   and\nPayPal for payouts" }],
      sourcePatterns,
      ["Tehseen Ahmed Resume - Senior Backend Engineer", "Tehseen_Sr_Software_Engineer"]
    );
    expect(result).toMatchObject({ total: 2, found: 1, recall: 0.5, missing: ["135+ currencies"], unindexed: [] });
  });

  it("does not credit a phrase found in a different document", () => {
    const result = evidenceRecall(
      item(),
      [{ documentName: "Tehseen_Sr_Software_Engineer", text: "Stripe and PayPal" }],
      sourcePatterns,
      ["Tehseen Ahmed Resume - Senior Backend Engineer", "Tehseen_Sr_Software_Engineer"]
    );
    expect(result.found).toBe(0);
  });

  it("excludes evidence from documents that are not indexed", () => {
    const result = evidenceRecall(item(), [], sourcePatterns, ["Tehseen_Sr_Software_Engineer"]);
    expect(result).toMatchObject({ total: 1, recall: 0, unindexed: ["Stripe and PayPal"] });
  });

  it("returns null recall when nothing is labeled", () => {
    expect(evidenceRecall(item({ evidence: [] }), [], sourcePatterns, []).recall).toBeNull();
  });
});

describe("answer scorers", () => {
  it("checks outcomes, allowing either for ambiguous items", () => {
    expect(outcomeCorrect(item(), "answered")).toBe(true);
    expect(outcomeCorrect(item(), "insufficient_evidence")).toBe(false);
    expect(outcomeCorrect(item({ expected_outcome: "either" }), "insufficient_evidence")).toBe(true);
  });

  it("requires one alternative from every fact group", () => {
    const facts = item({ required_facts: [["stripe"], ["paypal|braintree"]] });
    expect(requiredFactsMet(facts, "Stripe and Braintree").met).toBe(true);
    expect(requiredFactsMet(facts, "Stripe only")).toEqual({ met: false, missing: [["paypal|braintree"]] });
  });

  it("reports forbidden claims", () => {
    expect(forbiddenClaimHits(item(), "Migrated 1,800 users and raised $200K")).toEqual(["\\$200k", "1,?800 users"]);
    expect(forbiddenClaimHits(item(), "Migrated catalog data and sessions")).toEqual([]);
  });

  it("counts a conflict as surfaced only when two variants appear", () => {
    const conflict = item({ category: "conflicting_sources", conflict_variants: ["\\b7\\b", "8\\+"] });
    expect(conflictSurfaced(conflict, "The documents say 7 years in one place and 8+ in another.")).toBe(true);
    expect(conflictSurfaced(conflict, "Tehseen has 8+ years of experience.")).toBe(false);
    expect(conflictSurfaced(item(), "anything")).toBeNull();
  });

  it("normalizes typographic punctuation", () => {
    expect(normalizeText("Aug 2019 – Aug 2024’s  “ok”")).toBe("aug 2019 - aug 2024's \"ok\"");
  });
});

describe("summarize", () => {
  const results: EvalResult[] = [
    { id: "a", category: "single_fact", status: "ok", outcome: "answered", outcomeCorrect: true, recallAt5: 1, recallSelected: 1, requiredFactsMet: true, forbiddenHits: [], judgedParagraphs: 2, supportedParagraphs: 2, latencyMs: 100 },
    { id: "b", category: "synthesis", status: "ok", outcome: "insufficient_evidence", outcomeCorrect: false, recallAt5: 0.5, recallSelected: 0, requiredFactsMet: false, forbiddenHits: [], judgedParagraphs: 0, latencyMs: 300 },
    { id: "c", category: "claim_safety", status: "ok", outcome: "answered", outcomeCorrect: false, recallAt5: null, forbiddenHits: ["\\$200k"], judgedParagraphs: 2, supportedParagraphs: 1, latencyMs: 200 },
    { id: "d", category: "conflicting_sources", status: "ok", outcome: "answered", outcomeCorrect: true, conflictSurfaced: true, forbiddenHits: [], latencyMs: 400 },
    { id: "e", category: "abstention", status: "error", errorCode: "gemini_timeout", latencyMs: 15000 }
  ];
  const summary = summarize(results);

  it("separates errors from scored items", () => {
    expect(summary).toMatchObject({ total: 5, errors: 1, errorCodes: { gemini_timeout: 1 }, schemaValidity: 0.8 });
  });

  it("computes outcome, abstention and fact metrics over the right subsets", () => {
    expect(summary.outcomeAccuracy).toBe(0.5);
    expect(summary.answerableAnsweredRate).toBe(0.5);
    expect(summary.abstentionAccuracy).toBe(0);
    expect(summary.requiredFactsRate).toBe(1);
    expect(summary.conflictSurfacedRate).toBe(1);
  });

  it("averages recall only where evidence is labeled", () => {
    expect(summary.recallAt5).toBe(0.75);
    expect(summary.recallSelected).toBe(0.5);
  });

  it("weights groundedness by judged paragraphs and lists violations", () => {
    expect(summary.groundedness).toBe(0.75);
    expect(summary.forbiddenClaimViolations).toEqual(["c"]);
  });

  it("reports latency percentiles for successful calls only", () => {
    expect(summary.latencyP50Ms).toBe(300);
    expect(summary.latencyP95Ms).toBe(400);
  });
});
