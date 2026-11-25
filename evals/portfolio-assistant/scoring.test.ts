import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  conflictSurfaced,
  documentUsage,
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

const datasets = {
  "dataset.v1.jsonl": { single_fact: 24, synthesis: 8, abstention: 10, claim_safety: 6, adversarial: 6, conflicting_sources: 6 },
  "dataset.v2.jsonl": { single_fact: 24, synthesis: 8, abstention: 8, claim_safety: 6, adversarial: 6, incorrect_source: 8 }
};

describe.each(Object.entries(datasets))("%s", (file, expectedCounts) => {
  const items = parseDataset(readFileSync(path.join(here, file), "utf8"));

  it("has the planned category mix", () => {
    const counts = Object.fromEntries(
      [...new Set(items.map((i) => i.category))].map((category) => [category, items.filter((i) => i.category === category).length])
    );
    expect(items).toHaveLength(60);
    expect(counts).toEqual(expectedCounts);
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

  it("keeps every forbidden claim from firing on its own evidence", () => {
    for (const i of items) {
      for (const pattern of i.forbidden_claims) {
        for (const evidence of i.evidence) expect(new RegExp(pattern, "i").test(evidence.text), `${i.id}: ${pattern}`).toBe(false);
      }
    }
  });
});

describe("dataset.v2.jsonl ground truth", () => {
  const items = parseDataset(readFileSync(path.join(here, "dataset.v2.jsonl"), "utf8"));

  it("never uses the deliberately incorrect resumes as evidence", () => {
    const sources = new Set(items.flatMap((i) => i.evidence.map((e) => e.source)));
    for (const incorrect of ["backend", "legacy", "senior"]) expect(sources.has(incorrect)).toBe(false);
  });

  it("maps the canonical source to the corrected and currently indexed resumes but not the incorrect ones", () => {
    const documents = JSON.parse(readFileSync(path.join(here, "documents.json"), "utf8")) as Record<string, string>;
    const canonical = new RegExp(documents.canonical, "i");
    for (const name of ["tehseen-ahmed-resume.md", "tehseen-ahmed-resume.txt", "Tehseen_Ahmed_Senior_Software_Engineer_Resume.pdf", "Tehseen_Ahmed_Remote_Software_Engineer_Resume.pdf", "Tehseen_Ahmed_Senior_NodeJS_Developer_Resume.pdf"]) {
      expect(canonical.test(name), name).toBe(true);
    }
    for (const name of ["Tehseen_Sr_Software_Engineer.pdf", "Tehseen_Ahmed_Resume.pdf", "Tehseen Ahmed Resume - Senior Backend Engineer.docx"]) {
      expect(canonical.test(name), name).toBe(false);
    }
    expect(new RegExp(documents.museum, "i").test("museum-advocate-portfolio-evidence-package.md")).toBe(false);
  });

  it("has evidence that satisfies the required facts of every answerable item", () => {
    for (const i of items.filter((x) => x.expected_outcome === "answered")) {
      expect(requiredFactsMet(i, i.evidence.map((e) => e.text).join(" ")).met, i.id).toBe(true);
    }
  });

  it("flags values from the deliberately incorrect resumes", () => {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(forbiddenClaimHits(byId["inc-003"], "Tehseen has over 7 years of experience.")).not.toEqual([]);
    expect(forbiddenClaimHits(byId["inc-003"], "Tehseen has nearly 10 years of experience, including 8+ years of experience building Node.js backends.")).toEqual([]);
    expect(forbiddenClaimHits(byId["inc-004"], "Tehseen delivered 100+ projects.")).not.toEqual([]);
    expect(forbiddenClaimHits(byId["inc-002"], "Digitaleap: 2019-01 - Current")).not.toEqual([]);
    expect(forbiddenClaimHits(byId["inc-002"], "Tehseen led Digitaleap from Aug 2019 to Aug 2024.")).toEqual([]);
  });

  it("contains no contact details", () => {
    const text = readFileSync(path.join(here, "dataset.v2.jsonl"), "utf8");
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]|\+92|\d{3}\s?\d{3}\s?\d{4}/i);
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
  const withIncorrectSource: EvalResult[] = [
    ...results,
    { id: "f", category: "incorrect_source", status: "ok", outcome: "answered", outcomeCorrect: true, requiredFactsMet: true, forbiddenHits: [], latencyMs: 100 },
    { id: "g", category: "incorrect_source", status: "ok", outcome: "answered", outcomeCorrect: true, requiredFactsMet: true, forbiddenHits: ["100"], latencyMs: 100 },
    { id: "h", category: "incorrect_source", status: "ok", outcome: "insufficient_evidence", outcomeCorrect: false, latencyMs: 100 }
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

  it("scores incorrect-source items on canonical value and no leak", () => {
    expect(summarize(withIncorrectSource).incorrectSourceAccuracy).toBeCloseTo(1 / 3);
    expect(summary.incorrectSourceAccuracy).toBeNull();
  });

  it("reports latency percentiles for successful calls only", () => {
    expect(summary.latencyP50Ms).toBe(300);
    expect(summary.latencyP95Ms).toBe(400);
  });
});

describe("documentUsage", () => {
  const results: EvalResult[] = [
    { id: "a", category: "single_fact", status: "ok", outcome: "answered", outcomeCorrect: true, requiredFactsMet: true, forbiddenHits: [], retrievedDocuments: ["resume", "notes", "resume"], citedDocuments: ["resume"] },
    { id: "b", category: "synthesis", status: "ok", outcome: "answered", outcomeCorrect: true, requiredFactsMet: true, forbiddenHits: [], retrievedDocuments: ["notes", "case"], citedDocuments: ["notes", "case"] },
    { id: "c", category: "abstention", status: "ok", outcome: "answered", outcomeCorrect: false, forbiddenHits: [], retrievedDocuments: ["notes"], citedDocuments: ["notes"] },
    { id: "d", category: "single_fact", status: "ok", outcome: "answered", outcomeCorrect: true, requiredFactsMet: false, forbiddenHits: [], retrievedDocuments: ["notes"], citedDocuments: ["notes"] },
    { id: "e", category: "single_fact", status: "error", errorCode: "gemini_unavailable", retrievedDocuments: ["resume"] }
  ];
  const usage = Object.fromEntries(documentUsage(results).map((u) => [u.documentName, u]));

  it("counts each item once per document and splits citations by pass or fail", () => {
    expect(usage.resume).toMatchObject({ retrievedIn: 2, citedIn: 1, citedInPassing: 1, citedInFailing: 0, passingOnlySource: ["a"] });
    expect(usage.notes).toMatchObject({ retrievedIn: 4, citedIn: 3, citedInPassing: 1, citedInFailing: 2, passingOnlySource: [] });
    expect(usage.case).toMatchObject({ retrievedIn: 1, citedIn: 1, citedInPassing: 1, passingOnlySource: [] });
  });

  it("sorts by how often a document is retrieved", () => {
    expect(documentUsage(results).map((u) => u.documentName)).toEqual(["notes", "resume", "case"]);
  });
});
