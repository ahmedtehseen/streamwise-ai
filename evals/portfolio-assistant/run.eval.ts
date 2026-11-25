/**
 * Live Portfolio Assistant eval. Calls the same retrieval + Grounded Answer path
 * as the public API (without the public allowance), then scores the results.
 *
 *   npm run eval:portfolio                 # all items, judge on
 *   EVAL_LIMIT=5 npm run eval:portfolio    # first 5 items
 *   EVAL_JUDGE=0 npm run eval:portfolio    # skip the LLM judge
 *   EVAL_DELAY_MS=6000 ...                 # pause between items (free-tier rate limits)
 *
 * Needs GEMINI_API_KEY, NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY (read from .env.local when present). Writes
 * evals/portfolio-assistant/results/<run-id>.json and .md. Never logs secrets
 * or document text beyond the short excerpts stored in the result file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, vi } from "vitest";
import { PRIMARY_GENERATION_MODEL, SECONDARY_GENERATION_MODEL } from "../../lib/generation";
import { createKnowledgeClient, EMBEDDING_MODEL, KNOWLEDGE_DISTANCE_THRESHOLD, knowledgeConfiguration } from "../../lib/knowledge/server";
import { answerPortfolioQuestion, type PortfolioPipelineTrace } from "../../lib/knowledge/portfolio-assistant-service";
import { judgeParagraph, JUDGE_PROMPT_VERSION } from "./judge";
import {
  conflictSurfaced,
  evidenceRecall,
  forbiddenClaimHits,
  outcomeCorrect,
  parseDataset,
  requiredFactsMet,
  summarize,
  type EvalResult
} from "./scoring";

// The eval runs the server pipeline outside Next.js, like the route tests do.
vi.mock("server-only", () => ({}));

const here = path.dirname(new URL(import.meta.url).pathname);
const DATASET = "dataset.v1.jsonl";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Portfolio Assistant live eval", async () => {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const configuration = knowledgeConfiguration();
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const items = parseDataset(readFileSync(path.join(here, DATASET), "utf8"))
    .slice(0, Number(process.env.EVAL_LIMIT) || undefined);
  const sourcePatterns = Object.fromEntries(
    Object.entries(JSON.parse(readFileSync(path.join(here, "documents.json"), "utf8")) as Record<string, string>)
      .filter(([key]) => !key.startsWith("$"))
  );
  const useJudge = process.env.EVAL_JUDGE !== "0";
  const delayMs = Number(process.env.EVAL_DELAY_MS ?? 4000);

  const { data: documents, error } = await client.from("project_documents").select("name, status");
  if (error) throw new Error("Could not list Project Documents.");
  const indexedDocumentNames = (documents ?? []).filter((d) => d.status === "ready").map((d) => d.name as string);
  console.log(`Indexed documents (${indexedDocumentNames.length}): ${indexedDocumentNames.join(", ")}`);

  const results: Array<EvalResult & { question: string; answer?: string[]; judgeNotes?: string[]; missingEvidence?: string[]; unindexedEvidence?: string[]; missingFacts?: string[][] }> = [];
  for (const [index, item] of items.entries()) {
    const trace: PortfolioPipelineTrace = {};
    const started = Date.now();
    const result = await answerPortfolioQuestion(item.question, configuration, client, trace);
    const latencyMs = Date.now() - started;
    const toChunks = (chunks = trace.matchedChunks ?? []) => chunks.map((c) => ({ documentName: c.document_name, text: c.text }));
    const recallTop5 = evidenceRecall(item, toChunks(trace.matchedChunks), sourcePatterns, indexedDocumentNames);
    const recallSelected = evidenceRecall(item, toChunks(trace.selectedChunks), sourcePatterns, indexedDocumentNames);

    if (!result.ok) {
      results.push({ id: item.id, category: item.category, question: item.question, status: "error", errorCode: result.error.code ?? `http_${result.status}`, latencyMs, recallAt5: recallTop5.recall });
      console.log(`[${index + 1}/${items.length}] ${item.id} error ${result.error.code ?? result.status}`);
    } else {
      const answer = result.value;
      const text = answer.paragraphs.map((p) => p.text).join("\n");
      let supported = 0;
      const judgeNotes: string[] = [];
      if (useJudge) {
        for (const paragraph of answer.paragraphs) {
          try {
            const verdict = await judgeParagraph(paragraph.text, paragraph.sourceReferences.map((s) => s.excerpt), configuration.geminiApiKey);
            if (verdict.verdict === "supported") supported += 1;
            else judgeNotes.push(`${verdict.verdict}: ${verdict.unsupportedClaims.join("; ")}`);
          } catch {
            judgeNotes.push("judge_error");
          }
        }
      }
      const facts = requiredFactsMet(item, text);
      results.push({
        id: item.id,
        category: item.category,
        question: item.question,
        status: "ok",
        outcome: answer.outcome,
        outcomeCorrect: outcomeCorrect(item, answer.outcome),
        recallAt5: recallTop5.recall,
        recallSelected: recallSelected.recall,
        requiredFactsMet: facts.met,
        missingFacts: facts.missing,
        forbiddenHits: forbiddenClaimHits(item, text),
        conflictSurfaced: conflictSurfaced(item, text),
        paragraphs: answer.paragraphs.length,
        judgedParagraphs: useJudge ? answer.paragraphs.length : 0,
        supportedParagraphs: supported,
        latencyMs,
        answer: answer.paragraphs.map((p) => p.text),
        judgeNotes,
        missingEvidence: recallTop5.missing,
        unindexedEvidence: recallTop5.unindexed
      });
      console.log(`[${index + 1}/${items.length}] ${item.id} ${answer.outcome}${outcomeCorrect(item, answer.outcome) ? "" : " (unexpected)"}`);
    }
    if (index < items.length - 1) await sleep(delayMs);
  }

  const summary = summarize(results);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const meta = {
    runId,
    dataset: DATASET,
    itemCount: items.length,
    generationModels: [PRIMARY_GENERATION_MODEL, SECONDARY_GENERATION_MODEL],
    embeddingModel: EMBEDDING_MODEL,
    distanceThreshold: KNOWLEDGE_DISTANCE_THRESHOLD,
    judge: useJudge ? JUDGE_PROMPT_VERSION : "off",
    indexedDocumentNames
  };
  const outDir = path.join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${runId}.json`), JSON.stringify({ meta, summary, results }, null, 2));
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const failing = results.filter((r) => r.status === "error" || r.outcomeCorrect === false || (r.forbiddenHits ?? []).length > 0 || r.requiredFactsMet === false);
  writeFileSync(path.join(outDir, `${runId}.md`), [
    `# Portfolio Assistant eval — ${runId}`,
    "",
    `Dataset \`${DATASET}\` (${items.length} items) · models ${meta.generationModels.join(" → ")} · embeddings ${EMBEDDING_MODEL} · threshold ${KNOWLEDGE_DISTANCE_THRESHOLD} · judge ${meta.judge}`,
    `Indexed documents: ${indexedDocumentNames.join(", ") || "none"}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Valid Grounded Answers | ${pct(summary.schemaValidity)} (errors: ${summary.errors} ${JSON.stringify(summary.errorCodes)}) |`,
    `| Outcome accuracy (answer vs abstain) | ${pct(summary.outcomeAccuracy)} |`,
    `| Answerable questions answered | ${pct(summary.answerableAnsweredRate)} |`,
    `| Abstention accuracy (abstention, claim-safety, adversarial) | ${pct(summary.abstentionAccuracy)} |`,
    `| Retrieval recall@5 (raw top-5) | ${pct(summary.recallAt5)} |`,
    `| Retrieval recall after distance threshold | ${pct(summary.recallSelected)} |`,
    `| Required facts present (answered, answerable) | ${pct(summary.requiredFactsRate)} |`,
    `| Groundedness (judge: supported paragraphs) | ${pct(summary.groundedness)} |`,
    `| Conflicting sources surfaced | ${pct(summary.conflictSurfacedRate)} |`,
    `| Forbidden-claim violations | ${summary.forbiddenClaimViolations.length} ${summary.forbiddenClaimViolations.join(", ")} |`,
    `| Latency p50 / p95 (answer only, judge excluded) | ${summary.latencyP50Ms} ms / ${summary.latencyP95Ms} ms |`,
    "",
    "## Items needing attention",
    "",
    ...failing.map((r) => `- **${r.id}** (${r.category}): ${r.status === "error" ? `error ${r.errorCode}` : [
      r.outcomeCorrect === false ? `outcome ${r.outcome}` : "",
      r.requiredFactsMet === false ? `missing facts ${JSON.stringify(r.missingFacts)}` : "",
      (r.forbiddenHits ?? []).length ? `forbidden claim ${JSON.stringify(r.forbiddenHits)}` : ""
    ].filter(Boolean).join("; ")}`)
  ].join("\n"));
  console.log(JSON.stringify(summary, null, 2));
}, 2 * 60 * 60 * 1000);
