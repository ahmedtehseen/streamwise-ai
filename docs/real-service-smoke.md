# Week 6 real-service smoke test

Run this procedure against the configured Supabase project and Gemini API after the automated gate passes. It is an acceptance test, not a substitute for route tests. Record the date, commit, Supabase project reference, Gemini project, and each observed outcome without recording credentials.

## Safety and setup

1. Use a non-production Supabase project that contains no valuable Project Documents or Answer Flags. Back up anything that must be retained.
2. Apply every migration in `supabase/migrations/` in ascending filename order. Run `supabase/verify_knowledge_schema.sql`; every returned value must be `true`.
3. Configure `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, a high-entropy `ADMIN_SECRET`, and a high-entropy `VISITOR_ID_SECRET`. Configure `ANSWER_FLAG_SECRET` when a signing secret separate from the service-role key is desired. Do not use `NEXT_PUBLIC_` variables.
4. Choose a unique run identifier such as `w6-smoke-20261106-0415`. Prefix every temporary Project Document name with it and keep a list of created document and Answer Flag IDs.
5. Start the production build with `npm run build && npm start`. In another shell, use the application UI and its public API. Never paste secrets into logs, screenshots, or the smoke record.

If provider state prevents a required outcome, record the exact non-secret HTTP status, provider error category, and time. Mark the step blocked; do not treat a mocked response, an authentication failure, or a different model as proof of quota fallback or eligible retrieval degradation.

## 1. Migration and allowance proof

Use a separate, migrated test database containing no other allowance traffic. The command intentionally truncates only `public.public_allowance_buckets`, verifies concurrent limits, and truncates the table again during cleanup:

```sh
PUBLIC_ALLOWANCE_TEST_DATABASE_URL='<isolated migrated database>' \
PUBLIC_ALLOWANCE_TEST_CONFIRM=clear-test-buckets \
npm run allowance:verify
```

Require exactly 3 concurrent admissions for one Visitor, exactly 15 for distinct Visitors globally, no oversubscription at the Visitor or global Pacific-day boundary, and a reset at the next midnight in `America/Los_Angeles`.

Against the application project, send valid requests through Chat, Spec, task-draft creation, and the Portfolio Assistant using the same trusted Visitor address. Confirm they share the same durable counters. Confirm the fourth action inside one minute returns HTTP 429 with `limitedBy: "visitor_minute"`, a `resetAt` value, and a `Retry-After` header. Then use distinct trusted Visitor addresses and confirm the sixteenth action inside one minute returns `limitedBy: "global_minute"`. Use temporary bucket rows in the non-production project to repeat the Visitor/global daily-boundary checks. Confirm malformed requests consume nothing, requests without the trusted address fail closed, and Answer Flag and owner-only Project Document operations consume no action.

## 2. Primary generation and fallback

With primary quota available, submit one Chat message, one structured Spec, and one approved task draft. Confirm streaming is not duplicated, the Spec passes the existing schema, and the draft exactly matches the approved Spec.

When the configured Gemini project returns confirmed daily-quota exhaustion for `gemini-3.5-flash-lite`, repeat all three actions. Confirm one `gemini-3.1-flash-lite` attempt occurs inside the original admitted action and the same validation still applies. A short-window 429 is not daily-fallback proof. If both models report daily exhaustion, require the stable unavailable response with no provider detail. If daily quota cannot be safely exhausted during the test window, record this step as blocked by provider state.

## 3. Portfolio Assistant grounding and degraded retrieval

Upload `<run-id>-atlas.md`:

```markdown
# Atlas

## Release schedule

Atlas production deployments happen every Friday.
Release review begins at 14:00 UTC.
```

Confirm indexing becomes ready. Ask `When does Atlas deploy and when does release review begin?` and require a Grounded Answer whose factual paragraphs each include a Source Reference to the temporary Project Document. Ask `What is Atlas's annual infrastructure budget?` and require Insufficient Evidence with no invented answer.

When `gemini-embedding-2` returns an eligible temporary HTTP 408, 429, or 5xx for the configured project, ask `When does Atlas production deploy?`. Require the visible reduced-recall disclosure and a Grounded Answer with a valid Source Reference. Ask the budget question again and require visibly degraded Insufficient Evidence without answer generation. Authentication failure and an invalid-dimension vector must return an error, not degraded retrieval. If eligible provider failure cannot be induced safely, record this step as blocked by provider state.

## 4. Answer Flag workflow

Flag both the Grounded Answer and the Insufficient Evidence response, including a short note on one. Confirm each submission succeeds without Visitor identity storage and a second submission for the same issued response is rejected. Open owner review using the Portfolio Owner secret, confirm both immutable response snapshots and Source References are present, mark one Answer Flag reviewed, and confirm the response and Knowledge Base did not change.

## 5. Document Replacement isolation and atomic activation

Start a replacement for the ready Atlas Project Document. For failure isolation, run the application temporarily with a deliberately invalid Gemini key, submit `<run-id>-atlas-failed.md`, and restore the real key immediately. Require the candidate to fail while the current revision and its chunks remain ready and searchable. Authentication failure proves replacement isolation only; it is not evidence of eligible retrieval degradation. Confirm the failed candidate can be discarded.

Submit `<run-id>-atlas-v2.md` with changed facts using the real Gemini key:

```markdown
# Atlas

## Release schedule

Atlas production deployments happen every Tuesday.
Release review begins at 16:00 UTC.
```

While processing, confirm the Friday revision remains searchable. After success, require one ready replacement row and its chunks, no superseded row or chunks, and answers supported only by the Tuesday revision. This database change must be atomic. Also confirm a pending replacement does not consume one of the 20 active Project Document capacity slots and a second concurrent replacement is rejected.

## 6. Cleanup and smoke record

Delete every temporary Project Document through the owner operation and verify its chunks cascade to zero. Delete the temporary Answer Flags and allowance bucket rows directly in the non-production Supabase project. Stop the application, remove any temporary local Project Documents, and restore the original environment configuration.

The smoke record must include pass, fail, or blocked for each section; non-secret provider limitations; confirmation that all temporary rows and files were removed; and the output summary from migration validation, lint, automated tests, and the production build.
