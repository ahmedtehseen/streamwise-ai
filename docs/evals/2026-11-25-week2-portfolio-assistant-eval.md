# Week 2 Portfolio Assistant eval — baseline and error report (2026-11-25)

## Summary

- A versioned 60-question eval set and a reproducible harness now measure the live Portfolio Assistant (`npm run eval:portfolio`, `evals/portfolio-assistant/`).
- Four live runs were made against the production knowledge base. They ran on the owner's machine with the production Gemini and Supabase configuration: one v1 baseline, then v2 before, after and after-fix.
- The biggest quality problem is **retrieval context, not generation**. Markdown headings are removed from chunk text before embedding and before the model sees the passage, so a chunk can contain a fact without the entity it belongs to. Fixing one document format moved the wrong-resume trap questions from 14% to 86% correct.
- The only claim-safety failure (a project-context user-migration figure) came from an internal evidence document that was indexed publicly. Removing it with the owner's approval eliminated the violation.
- Provider instability is material: 10–13 of 60 questions per run failed with `gemini_unavailable`. That is Week 4 work.

## Setup

| Item | Value |
| --- | --- |
| Pipeline | `answerPortfolioQuestion` (same retrieval + Grounded Answer path as the public API, without the public allowance) |
| Generation | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` fallback |
| Embeddings | `gemini-embedding-2`, hybrid search, top-5, distance threshold 0.7 |
| Judge | `groundedness-judge.v1` (same Gemini family; estimate only) |
| Dataset v1 | 60 items labelled from three resumes the owner later confirmed are deliberately incorrect and not indexed |
| Dataset v2 | 60 items: 24 single fact, 8 synthesis, 8 abstention, 6 claim safety, 6 prompt injection, 8 incorrect-source traps. Career facts come from the owner's canonical resume and project facts from the public case studies |
| Pacing | 4 s between items; one run ≈ 8–10 min |

Ground truth rules: only the canonical resume is true for career facts. Values that appear only in the incorrect resumes (for example, 7 years of experience, 100+ projects, or Oct 2017 / Jan 2019 Digitaleap start dates) are forbidden claims.

## Runs

| Run | Knowledge base | Dataset | Errors | Outcome acc. | Answerable answered | Abstention acc. | Recall@5 | Required facts | Incorrect-source acc. | Groundedness | Forbidden claims | p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `2026-11-25T22-33-28-830Z` | 15 docs (original) | v1 | 6 | 74.1% | 70.0% | 94.7% | n/a¹ | 71.4% | n/a | 80.0% | 1 (cs-001) | 2.3 s / 6.3 s |
| `2026-11-25T22-56-07-917Z` | 15 docs (original) | v2 | 13 | 78.7% | 73.1% | 100% | 47.0% | 89.5% | 33.3% | 83.3% | 1 (cs-001) | 4.7 s / 7.0 s |
| `2026-11-25T23-14-59-619Z` | 13 docs, Markdown resume | v2 | 10 | 62.0% | 50.0% | 100% | 29.4% | 76.9% | 14.3% | 86.7% | 0 | 2.7 s / 6.6 s |
| `2026-11-25T23-31-50-046Z` | 13 docs, plain-text resume | v2 | 10 | 74.0% | 55.6% | 100% | 32.9% | 60.0% | **85.7%** | 81.8% | 0 | 4.1 s / 8.8 s |

¹ v1 evidence pointed at documents that are not indexed, so recall could not be scored.

Metrics are computed over non-error items only. With 10–13 provider errors per run, differences of a few points are within noise.

Knowledge-base changes between runs (owner-approved, applied through the owner API):
1. The two indexed resume variants, which shared the canonical facts but contained contact details, were replaced by one redacted copy of the canonical resume. The home-page copy was replaced by an email-free version. The internal Museum Advocate evidence package was removed.
2. The Markdown resume was replaced by a plain-text copy with identical wording (see finding 1).

## Error analysis

### 1. Markdown headings are dropped from chunk text (root cause of most false abstentions)

`chunkProjectDocument` stores Markdown headings only in `heading_path`. The embedding (`embedProjectDocumentPassage(chunk.text)`) and the evidence passed to the model (`chunk.text`) never include the heading. Full-text search does include it.

Checked by chunking the canonical resume locally:

| Format | Chunks | Chunk that holds the Digitaleap dates mentions "Digitaleap"? | Canonical evidence phrases present in chunk text |
| --- | --- | --- | --- |
| Markdown (`### Principal Engineer & Founder — Digitaleap`) | 8 | No | 48 / 55 |
| Original PDF text | 2 | Yes | 55 / 55 |
| Same words as plain text | 2 | Yes | 55 / 55 |

With the Markdown copy, "When did Tehseen start Digitaleap?" can only retrieve a passage that says `Karachi, Pakistan | Aug 2019 – Aug 2024`, with no company named, so the model correctly abstains. Switching to the plain-text copy turned inc-001, inc-002, inc-004, inc-005, inc-006, sf-003, sf-010, sf-016 and mh-003 from Insufficient Evidence into correct answers.

The same loss affects every Markdown document still indexed: the Museum Advocate and Serve Me case studies, Upwork entries, Project Portfolio and Proposal Examples. A section such as `## Outcomes` under `# Museum Advocate` is embedded without the project name.

**Proposed fix (next PR):** prefix each chunk's text with its heading path for embedding and for the evidence shown to the model ("contextual chunk headers"), keep `heading_path` for display, then re-index the Markdown documents through Document Replacement. Re-run v2 to confirm.

### 2. Small resume chunks lose to long case-study chunks

Even with the plain-text resume, single-fact resume questions still abstain intermittently. sf-001 (location), sf-012 (auth techniques), sf-021 (CI/CD platforms) and inc-007 (degree) were answered in one run and abstained in the next. Recall@5 is about 33%. The resume is 2 of roughly 100 chunks, and generic questions ("Which databases has…") pull in long case-study or proposal chunks that mention similar technologies.

Candidate fixes to evaluate after finding 1: per-document diversity in the top-k (at most 2 chunks per document), a larger candidate pool before the threshold, or a document-type boost for the resume on "who/what/when" questions about Tehseen.

### 3. Internal guidance documents are indexed publicly

- The Museum Advocate evidence package produced the only forbidden claim: it answered cs-001 with the user-migration figure. Removing it eliminated the violation in both later runs.
- Residual risk: the public website case study still mentions that figure in its "worded conservatively" section. It is grounded, but it contradicts the claim-safety rule. Consider rewording that section.
- `Project Portfolio.md` and `Proposal Examples.md` are proposal-writing guidance for the owner, not public portfolio content. For example, the "Which companies has Tehseen worked for?" answer came from portfolio project names, not employers. They remain indexed pending an owner decision.

### 4. Provider errors

Between 10 and 13 of 60 items per v2 run returned `gemini_unavailable`, plus 1–2 `invalid_model_output`. The judge saw some errors too. This is the biggest threat to measurement validity and to the public experience. It feeds Week 4 (retry budget, fallback health, fault drills). Until then, compare runs on items that succeeded in both.

### 5. Answer-key lessons

- The first answer key (v1) was built from documents that were never indexed. The harness now lists indexed documents in every report and maps evidence sources to document names (`documents.json`). A unit test also checks that the incorrect resumes never count as evidence.
- Required-fact regexes on synthesis items (for example, sf-014 and sf-015) are strict about wording and may undercount. Spot-check these by hand before reading too much into "required facts present".

## Reproduce

```sh
EVAL_DATASET=dataset.v2.jsonl EVAL_DELAY_MS=4000 npm run eval:portfolio
```

This needs `GEMINI_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. It is read-only against the knowledge base and makes about 240 Gemini calls with the judge on. Result `.json` files include answer text and are git-ignored. Full results for the runs above are kept privately with the owner.
