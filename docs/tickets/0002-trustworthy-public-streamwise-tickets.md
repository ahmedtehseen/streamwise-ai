# Week 6: Trustworthy Public Streamwise tickets

**Parent Spec**: `docs/specs/0002-trustworthy-public-streamwise.md`

## W6-1: Enforce one durable public usage allowance

**Depends on**: Nothing

### Outcome

Every public AI entry point is admitted through one concurrency-safe allowance before invoking Gemini.

### Requirements

1. Add the smallest durable Supabase schema and atomic database operation needed to enforce Visitor and global minute and Pacific-day buckets.
2. Derive a daily one-way Visitor identifier from the hosting platform's trusted client-address signal without storing the raw request address; fail closed when that signal is unavailable.
3. Enforce 3 actions per Visitor per minute, 15 globally per minute, 10 per Visitor per Pacific day, and 50 globally per Pacific day.
4. Apply the same admission helper to Chat, Spec generation, task-draft creation, and Portfolio Assistant questions.
5. Count one admitted user operation once; internal fallback attempts do not consume another action.
6. Return HTTP 429 with the applicable reset time and fail closed when durable allowance state cannot be checked.
7. Make every owner-only operation fail closed in production when `ADMIN_SECRET` is absent or invalid while preserving open local development.
8. Test counter concurrency, shared-route consumption, reset boundaries, rejected input, missing network identity, and unavailable allowance storage.

### Acceptance

- Concurrent requests cannot oversubscribe a bucket.
- Switching public modes cannot bypass Visitor or global limits.
- No raw request address or secret is exposed or persisted.

---

## W6-2: Centralize generation routing and safe fallback

**Depends on**: W6-1

### Outcome

All generation routes consistently use the primary model, bounded retry, and one compatible secondary model without weakening their contracts.

### Requirements

1. Consolidate the repeated Gemini generation request behavior in the responsible server layer.
2. Use `gemini-3.5-flash-lite` as primary and `gemini-3.1-flash-lite` as secondary.
3. Distinguish confirmed daily-quota exhaustion from short-window rate limiting and unrelated failures.
4. Apply bounded retry with backoff and jitter to eligible transient rate limits.
5. Attempt the secondary model once for confirmed primary daily-quota exhaustion.
6. Permit streaming fallback only before Chat emits content.
7. Preserve current Zod schemas, response schemas, tool declarations, exact approved-spec checks, and safe public error mapping.
8. Test routing for Chat streaming, Spec generation, task drafts, and grounded-answer generation.

### Acceptance

- The fallback attempt remains part of the initially admitted action.
- A partially emitted Chat response is never restarted.
- Invalid fallback output is rejected by the same validation as primary output.

---

## W6-3: Degrade Portfolio Assistant retrieval to full-text search

**Depends on**: W6-1, W6-2

### Outcome

Portfolio questions remain safely answerable from keyword evidence when Embedding 2 is temporarily unavailable.

### Requirements

1. Keep `gemini-embedding-2` and 768 dimensions as the sole vector-space invariant.
2. Add or extend the retrieval database operation so ready Project Documents can be ranked with full-text search without a query vector.
3. Enter degraded retrieval only after bounded handling of an eligible embedding failure.
4. Preserve Grounded Answer, Source Reference, prompt-injection, ready-document, and Insufficient Evidence checks.
5. Include an explicit degraded-retrieval marker in the API response and UI.
6. Do not invoke answer generation when keyword evidence is insufficient.
7. Test exact keyword recall, absent evidence, citation validation, and the prohibition on mixed embedding models.

### Acceptance

- Degraded retrieval never queries or writes an incompatible embedding space.
- Visitors can distinguish degraded search from normal hybrid search.
- No-evidence behavior remains deterministic.

---

## W6-4: Capture and review Answer Flags

**Depends on**: W6-1, W6-3

### Outcome

Visitors can report problematic Portfolio Assistant outcomes, and the Portfolio Owner can review those reports without automated side effects.

### Requirements

1. Add an Answer Flag record with issued response identity, question, outcome snapshot, Source References, response time, optional 500-character note, status, and review time.
2. Return a server-verifiable response identity with Grounded Answer and Insufficient Evidence results.
3. Accept at most one flag per issued response and reject forged, malformed, or oversized submissions.
4. Store no Visitor identity with an Answer Flag.
5. Add owner-authorized list and mark-reviewed operations.
6. Add a small Visitor flag flow and a protected owner review surface.
7. Ensure flags never regenerate content, alter retrieval, or mutate Project Documents.
8. Test public submission, duplicate prevention, response verification, note limits, authorization, and review transitions.

### Acceptance

- Both Grounded Answer and Insufficient Evidence responses can be flagged once.
- Only the Portfolio Owner can inspect or review flags.
- Flagging has no automatic product side effects.

---

## W6-5: Replace Project Documents without interrupting evidence

**Depends on**: W6-1, W6-3

### Outcome

The Portfolio Owner can safely replace a Project Document while Visitors continue receiving evidence from the last known-good revision.

### Requirements

1. Add the minimum schema needed to associate one pending replacement with one ready Project Document.
2. Reuse existing upload validation, extraction, chunking, deduplication, embedding, failure, and retry behavior.
3. Exclude a replacement candidate from the 20-document capacity calculation.
4. Keep the current document ready during candidate processing.
5. Activate a successful candidate and remove the superseded document and chunks in one transaction.
6. Preserve the current document when candidate processing fails; allow owner retry or discard.
7. Reject a second concurrent replacement for the same document.
8. Make deletion of the current document discard its pending replacement.
9. Add the replacement workflow to the owner UI without adding history or rollback controls.
10. Test success, failure, retry, discard, concurrent replacement, duplicate content, full capacity, atomic activation, and cascading cleanup.

### Acceptance

- Visitors never observe a gap caused by replacement indexing.
- Failed replacements cannot contaminate retrieval.
- Only one active revision contributes chunks after activation.

---

## W6-6: Align product language and prove the integrated Week 6 workflow

**Depends on**: W6-2, W6-3, W6-4, W6-5

### Outcome

The product consistently presents the Portfolio Assistant and documents a reproducible, verified Week 6 workflow.

### Requirements

1. Replace current product-facing uses of the rejected term “Project Knowledge Assistant” with “Portfolio Assistant,” excluding historical context where needed.
2. Update the README with public allowances, generation fallback, degraded retrieval, Answer Flags, Document Replacement, owner boundaries, and production configuration.
3. Extend the real-service smoke test to cover shared limits, model and retrieval degradation, flag review, failed replacement, and successful atomic activation.
4. Run migration validation, lint, the complete automated test suite, and the production build.
5. Execute the real-service smoke test against the configured private Supabase project and Gemini API, recording any provider-specific limitations without weakening acceptance criteria.

### Acceptance

- Product language follows `GLOSSARY.md`.
- Automated and real-service proof covers the complete Week 6 outcome.
- No documentation claims multi-user or private-client authorization.
