# Week 2 Portfolio Assistant eval — baseline and error report (2026-11-25/26)

## Summary

- A versioned 60-question eval set and a reproducible harness now measure the live Portfolio Assistant (`npm run eval:portfolio`, `evals/portfolio-assistant/`).
- Six live runs were made against the production knowledge base. They ran on the owner's machine with the production Gemini and Supabase configuration: one v1 baseline, then five v2 runs around three owner-approved knowledge-base changes.
- The biggest quality problem was **retrieval, not generation**. One internal proposal-notes document took 198 of 300 top-5 slots across the 60 questions. Removing it and a second internal document raised recall@5 from 33% to 80%, outcome accuracy from 73% to 94.5%, and answerable questions answered from 53% to 89%.
- A second retrieval problem remains in code. Markdown headings are removed from chunk text before embedding and before the model sees the passage, so a chunk can contain a fact without the entity it belongs to. Fixing one document format moved the wrong-resume trap questions from 14% to 86% correct.
- The only real claim-safety failure (a project-context user-migration figure) came from an internal evidence document that was indexed publicly. Removing it with the owner's approval eliminated the violation; the last mention in a public case study was then removed too.
- Provider instability is material: 1–13 of 60 questions per run failed with `gemini_unavailable`. That is Week 4 work.

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
| `2026-11-26T00-15-38-064Z` | 13 docs (repeat before change 3) | v2 | 1 | 72.9% | 53.1% | 100% | 32.9% | 70.6% | 87.5% | 88.0% | 0 | 3.1 s / 6.5 s |
| `2026-11-26T00-26-37-742Z` | **11 docs, internal notes removed** | v2 | 5 | **94.5%** | **89.3%** | 100% | **80.4%** | 88.0% | 87.5% | 84.2% | 1 (inc-002)² | 3.7 s / 7.0 s |

¹ v1 evidence pointed at documents that are not indexed, so recall could not be scored.
² False positive: the answer said Tehseen is "not still running" Digitaleap and gave the 2019–2024 dates, which is correct. The pattern now ignores negated phrasing (finding 5).

Metrics are computed over non-error items only. With 10–13 provider errors per run, differences of a few points are within noise.

Knowledge-base changes between runs (owner-approved, applied through the owner API):
1. The two indexed resume variants, which shared the canonical facts but contained contact details, were replaced by one redacted copy of the canonical resume. The home-page copy was replaced by an email-free version. The internal Museum Advocate evidence package was removed.
2. The Markdown resume was replaced by a plain-text copy with identical wording (see finding 1).
3. `Project Portfolio.md` and `Proposal Examples.md` (internal proposal-writing notes) were removed, and the Museum Advocate website case study was replaced by a copy without its user-migration bullet (findings 2 and 3).

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

### 2. One internal document crowded everything else out of the top 5

With the plain-text resume, single-fact resume questions still abstained intermittently and recall@5 stayed near 33%. The per-document usage table added to the harness showed why: `Project Portfolio.md` appeared in 55 of 60 top-5 lists and took 198 of the 300 slots, but was cited by only 4 answers (1 passing). It is a long note that mentions most technologies and projects, so its chunks match almost any question. The resume appeared in only 15 top-5 lists, but when it did it was cited 14 times, all passing.

After removing the two internal notes, the resume appeared in 45 top-5 lists and was the only source for 21 passing answers; recall@5 rose to 80.4%.

Remaining risk: any single long, keyword-dense document can do this again. Candidate guards, to evaluate after finding 1: per-document diversity in the top-k (at most 2 chunks per document), or a larger candidate pool before the threshold.

### 3. Internal guidance documents are indexed publicly

- The Museum Advocate evidence package produced the only forbidden claim: it answered cs-001 with the user-migration figure. Removing it eliminated the violation in both later runs.
- The public website case study still mentioned that figure in one bullet of its "worded conservatively" section. With the owner's approval that line was removed from the indexed copy (2026-11-26); no later answer mentions the figure.
- `Project Portfolio.md` and `Proposal Examples.md` were proposal-writing notes for the owner, not public portfolio content: client first names and job details, Upwork strategy, team-composition and verification notes. Every project they named is covered by public pages. With the owner's approval both were removed (2026-11-26).

### 4. Provider errors

Between 1 and 13 of 60 items per v2 run returned `gemini_unavailable`, plus 1–2 `invalid_model_output` in some runs. The judge saw some errors too. This is the biggest threat to measurement validity and to the public experience. It feeds Week 4 (retry budget, fallback health, fault drills). Until then, compare runs on items that succeeded in both.

### 5. Answer-key lessons

- The first answer key (v1) was built from documents that were never indexed. The harness now lists indexed documents in every report and maps evidence sources to document names (`documents.json`). A unit test also checks that the incorrect resumes never count as evidence.
- Forbidden-claim regexes must allow negation. inc-002 flagged a correct "not still running" answer; the pattern now skips phrases preceded by "not" or "n't", with a unit test.
- Required-fact regexes on synthesis items (for example, sf-014 and sf-015) are strict about wording and may undercount. Spot-check these by hand before reading too much into "required facts present".

## Reproduce

```sh
EVAL_DATASET=dataset.v2.jsonl EVAL_DELAY_MS=4000 npm run eval:portfolio
```

This needs `GEMINI_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`. It is read-only against the knowledge base and makes about 240 Gemini calls with the judge on. Result `.json` files include answer text and are git-ignored. Full results for the runs above are kept privately with the owner.
