/**
 * Deterministic scorers for the Portfolio Assistant eval. Pure functions so they
 * run in normal CI; the live runner (run.eval.ts) supplies retrieval and answers.
 */

export type EvalOutcome = "answered" | "insufficient_evidence";

export type EvalItem = {
  id: string;
  /**
   * conflicting_sources (v1): documents disagree and the answer should surface it.
   * incorrect_source (v2): only the canonical document is true; the answer must give
   * its value and never a value from a deliberately incorrect document.
   */
  category: "single_fact" | "synthesis" | "abstention" | "claim_safety" | "adversarial" | "conflicting_sources" | "incorrect_source";
  question: string;
  expected_outcome: EvalOutcome | "either";
  evidence: Array<{ source: string; text: string }>;
  required_facts: string[][];
  forbidden_claims: string[];
  conflict_variants?: string[];
  notes?: string;
};

export type RetrievedChunk = { documentName: string; text: string };

export function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDataset(jsonl: string): EvalItem[] {
  const items = jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalItem);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate eval id ${item.id}`);
    ids.add(item.id);
    if (!item.question.trim()) throw new Error(`Empty question in ${item.id}`);
    if (item.expected_outcome === "answered" && item.category !== "conflicting_sources" && item.evidence.length === 0) {
      throw new Error(`Answerable item ${item.id} has no evidence`);
    }
    for (const pattern of [...item.required_facts.flat(), ...item.forbidden_claims, ...(item.conflict_variants ?? [])]) {
      new RegExp(pattern, "i");
    }
  }
  return items;
}

/**
 * Recall of labeled evidence phrases in the retrieved chunks. Only evidence whose
 * source document is indexed counts; the rest is reported as unindexed.
 */
export function evidenceRecall(
  item: EvalItem,
  chunks: RetrievedChunk[],
  sourcePatterns: Record<string, string>,
  indexedDocumentNames: string[]
) {
  const indexed = item.evidence.filter((evidence) => {
    const pattern = sourcePatterns[evidence.source];
    return pattern !== undefined && indexedDocumentNames.some((name) => new RegExp(pattern, "i").test(name));
  });
  const found = indexed.filter((evidence) => {
    const pattern = new RegExp(sourcePatterns[evidence.source], "i");
    const phrase = normalizeText(evidence.text);
    return chunks.some((chunk) => pattern.test(chunk.documentName) && normalizeText(chunk.text).includes(phrase));
  });
  return {
    total: indexed.length,
    found: found.length,
    recall: indexed.length === 0 ? null : found.length / indexed.length,
    missing: indexed.filter((evidence) => !found.includes(evidence)).map((evidence) => evidence.text),
    unindexed: item.evidence.filter((evidence) => !indexed.includes(evidence)).map((evidence) => evidence.text)
  };
}

export function outcomeCorrect(item: EvalItem, outcome: EvalOutcome) {
  return item.expected_outcome === "either" || item.expected_outcome === outcome;
}

/** Every group must match at least one of its alternatives. */
export function requiredFactsMet(item: EvalItem, answerText: string) {
  const missing = item.required_facts.filter(
    (group) => !group.some((pattern) => new RegExp(pattern, "i").test(answerText))
  );
  return { met: missing.length === 0, missing };
}

export function forbiddenClaimHits(item: EvalItem, answerText: string) {
  return item.forbidden_claims.filter((pattern) => new RegExp(pattern, "i").test(answerText));
}

/** A conflict is handled when the answer surfaces at least two of the disagreeing variants. */
export function conflictSurfaced(item: EvalItem, answerText: string) {
  const variants = item.conflict_variants ?? [];
  if (variants.length === 0) return null;
  return variants.filter((pattern) => new RegExp(pattern, "i").test(answerText)).length >= 2;
}

export type EvalResult = {
  id: string;
  category: EvalItem["category"];
  status: "ok" | "error";
  errorCode?: string;
  outcome?: EvalOutcome;
  outcomeCorrect?: boolean;
  recallAt5?: number | null;
  recallSelected?: number | null;
  requiredFactsMet?: boolean;
  forbiddenHits?: string[];
  conflictSurfaced?: boolean | null;
  paragraphs?: number;
  supportedParagraphs?: number;
  judgedParagraphs?: number;
  latencyMs?: number;
  /** Document names of the raw top-5 chunks, in rank order (duplicates kept). */
  retrievedDocuments?: string[];
  /** Document names the Grounded Answer cited. */
  citedDocuments?: string[];
};

export type DocumentUsage = {
  documentName: string;
  retrievedIn: number;
  citedIn: number;
  citedInPassing: number;
  citedInFailing: number;
  passingOnlySource: string[];
};

/**
 * Passing means the answer was expected and complete: outcome correct, required
 * facts present, no forbidden claims. "Only source" lists passing items whose
 * citations came from this document alone, i.e. answers that depended on it.
 */
export function itemPassed(result: EvalResult) {
  return result.status === "ok" && result.outcomeCorrect === true && result.requiredFactsMet !== false && (result.forbiddenHits ?? []).length === 0;
}

export function documentUsage(results: EvalResult[]): DocumentUsage[] {
  const names = new Set(results.flatMap((r) => [...(r.retrievedDocuments ?? []), ...(r.citedDocuments ?? [])]));
  return [...names]
    .map((documentName) => {
      const retrieved = results.filter((r) => (r.retrievedDocuments ?? []).includes(documentName));
      const cited = results.filter((r) => (r.citedDocuments ?? []).includes(documentName));
      return {
        documentName,
        retrievedIn: retrieved.length,
        citedIn: cited.length,
        citedInPassing: cited.filter(itemPassed).length,
        citedInFailing: cited.filter((r) => !itemPassed(r)).length,
        passingOnlySource: cited.filter((r) => itemPassed(r) && new Set(r.citedDocuments).size === 1).map((r) => r.id)
      };
    })
    .sort((a, b) => b.retrievedIn - a.retrievedIn || a.documentName.localeCompare(b.documentName));
}

function mean(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarize(results: EvalResult[]) {
  const ok = results.filter((result) => result.status === "ok");
  const answerable = ok.filter((result) => result.category === "single_fact" || result.category === "synthesis");
  const mustAbstain = ok.filter((result) => result.category === "abstention" || result.category === "claim_safety" || result.category === "adversarial");
  const incorrectSource = ok.filter((result) => result.category === "incorrect_source");
  const judged = ok.filter((result) => (result.judgedParagraphs ?? 0) > 0);
  const latencies = ok.map((result) => result.latencyMs ?? 0).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
  return {
    total: results.length,
    errors: results.length - ok.length,
    errorCodes: Object.fromEntries(
      [...new Set(results.filter((r) => r.status === "error").map((r) => r.errorCode ?? "unknown"))].map((code) => [
        code,
        results.filter((r) => r.status === "error" && (r.errorCode ?? "unknown") === code).length
      ])
    ),
    schemaValidity: results.length ? ok.length / results.length : null,
    outcomeAccuracy: mean(ok.map((r) => (r.outcomeCorrect ? 1 : 0))),
    answerableAnsweredRate: mean(answerable.map((r) => (r.outcome === "answered" ? 1 : 0))),
    abstentionAccuracy: mean(mustAbstain.map((r) => (r.outcomeCorrect ? 1 : 0))),
    recallAt5: mean(ok.map((r) => r.recallAt5).filter((v): v is number => typeof v === "number")),
    recallSelected: mean(ok.map((r) => r.recallSelected).filter((v): v is number => typeof v === "number")),
    requiredFactsRate: mean(answerable.filter((r) => r.outcome === "answered").map((r) => (r.requiredFactsMet ? 1 : 0))),
    forbiddenClaimViolations: ok.filter((r) => (r.forbiddenHits ?? []).length > 0).map((r) => r.id),
    incorrectSourceAccuracy: mean(incorrectSource.map((r) => (r.outcome === "answered" && r.requiredFactsMet && (r.forbiddenHits ?? []).length === 0 ? 1 : 0))),
    conflictSurfacedRate: mean(ok.filter((r) => r.category === "conflicting_sources" && r.outcome === "answered" && r.conflictSurfaced !== null).map((r) => (r.conflictSurfaced ? 1 : 0))),
    groundedness: judged.length
      ? judged.reduce((sum, r) => sum + (r.supportedParagraphs ?? 0), 0) / judged.reduce((sum, r) => sum + (r.judgedParagraphs ?? 0), 0)
      : null,
    latencyP50Ms: percentile(0.5),
    latencyP95Ms: percentile(0.95)
  };
}
