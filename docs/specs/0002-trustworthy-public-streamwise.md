# Specification: Trustworthy Public Streamwise

## Status

Approved

## Context

Weeks 1–5 established public Chat, structured Spec generation, approved task drafts, multimodal intake, and the source-grounded Portfolio Assistant. Week 6 makes those capabilities safe to expose within the Gemini and Supabase free tiers while keeping the Knowledge Base under the Portfolio Owner's control.

Streamwise remains a single-owner portfolio product. Visitors do not need accounts, and the product does not claim to protect private client work through tenant or project permissions.

## Outcome

A Visitor can explore every public AI capability within clear shared usage limits. The Portfolio Owner can review Answer Flags and replace Project Documents without interrupting the last known-good Knowledge Base. Provider quota exhaustion degrades predictably without weakening grounding or exposing administration.

## Public and owner boundaries

- Chat, Spec generation, task-draft creation, and the Portfolio Assistant remain public and anonymous.
- Knowledge Base upload, retry, replacement, deletion, and Answer Flag review require the owner secret.
- Owner-only operations fail closed in production when `ADMIN_SECRET` is missing or invalid.
- Open owner operations without `ADMIN_SECRET` remain acceptable only in local development.
- Provider keys and privileged Supabase credentials never reach the browser. The owner secret is supplied explicitly by the Portfolio Owner and is never embedded in public assets, returned by an API, or written to application logs.

## Shared usage allowance

All public AI capabilities consume one shared allowance.

| Limit | Allowance |
| --- | --- |
| Per Visitor per minute | 3 actions |
| Global per minute | 15 actions |
| Per Visitor per Pacific day | 10 actions |
| Global per Pacific day | 50 actions |

Daily windows reset at midnight in `America/Los_Angeles`, matching the Gemini API's daily reset boundary.

One action is one intentional provider-backed operation:

- sending one Chat message;
- generating one Spec;
- creating one task draft;
- asking one Portfolio Assistant question.

Navigation and Answer Flags consume no action. A fallback provider attempt remains part of the original action. Malformed requests rejected before admission consume nothing. Once an admitted request invokes a provider, it consumes one action even if the provider subsequently fails.

The server derives a daily, one-way Visitor identifier from the hosting platform's trusted client-address signal with a server-only secret. It never stores the raw address. A request without a trustworthy client address fails closed. One atomic durable operation must enforce all applicable Visitor and global minute and day limits before a provider is invoked. If allowance state cannot be checked, the request fails closed without invoking a provider.

Owner-only Project Document indexing bypasses Visitor allowances but remains subject to provider availability.

Limit responses use HTTP 429 and include enough information for the UI to show when the applicable Pacific-time window resets.

## Generation model routing

- `gemini-3.5-flash-lite` is the primary generation model for every generation route.
- `gemini-3.1-flash-lite` is the secondary generation model.
- Confirmed primary daily-quota exhaustion permits one secondary attempt within the same public action.
- Short-window provider rate limits receive bounded retry with backoff and jitter before failing.
- Other validation, authentication, client, or provider errors do not trigger model fallback.
- Streaming Chat may fall back only before response content has been emitted. A failed partial stream must not restart and duplicate content.
- Structured Spec output and task tool calls from either model must pass the same existing server-side validation. Model fallback never relaxes schemas or approval checks.
- If both generation models are unavailable, the API returns a stable unavailable outcome rather than leaking provider details.

## Embedding and retrieval degradation

`gemini-embedding-2` remains the only embedding model. Vectors from `gemini-embedding-001` must never be compared with, inserted into, or used as query vectors for the Embedding 2 index.

After bounded handling of a temporary Embedding 2 failure or quota exhaustion, Portfolio Assistant retrieval falls back to PostgreSQL full-text search over ready Project Documents. A degraded response must:

- identify that semantic search is temporarily unavailable;
- continue returning only Grounded Answers with valid Source References or Insufficient Evidence;
- never broaden the approved evidence set;
- never treat the absence of keyword matches as permission to answer from model knowledge.

## Answer Flags

Visitors can flag either a Grounded Answer or an Insufficient Evidence response.

An Answer Flag preserves:

- a server-issued response identifier;
- the original question;
- the outcome and returned answer content;
- Source References, when present;
- the response timestamp;
- an optional Visitor note of at most 500 characters;
- open or reviewed status.

At most one Answer Flag may exist for a returned response. Public input is length-limited, schema-validated, and tied to a response issued by the server so arbitrary feedback records cannot be manufactured. No visitor identity is stored with a flag.

The Portfolio Owner can list open and reviewed flags and mark an open flag reviewed. A flag never regenerates an answer, changes retrieval, or mutates a Project Document automatically.

## Document Replacement

The Portfolio Owner can propose a Document Replacement for a ready Project Document.

- Only one pending replacement may exist for a Project Document.
- A replacement is validated, extracted, chunked, and embedded using the same invariants as a new upload.
- The current Project Document remains ready and searchable while its replacement is processed.
- A replacement candidate is excluded from the 20-Project-Document capacity calculation.
- Existing duplicate-content protections still apply.
- Successful activation atomically makes the candidate ready and removes the superseded Project Document and its chunks.
- A failed candidate never affects the current ready Project Document and can be retried or discarded by the Portfolio Owner.
- Deleting a Project Document also discards its pending replacement, if any.
- The product does not retain superseded revisions or offer rollback history.

## Error and trust invariants

- Provider error bodies and secrets are not returned to Visitors.
- Rate-limit admission is concurrency-safe; parallel requests cannot oversubscribe a bucket.
- Grounded Answer and Source Reference validation remains identical across normal and degraded retrieval.
- Admin authorization is applied consistently to every mutation and Answer Flag review route.
- Model or retrieval fallback is observable and testable; it is never a silent relaxation of correctness.

## Non-goals

- Visitor accounts or authentication
- Multi-tenant workspaces
- Project-scoped or per-document visitor permissions
- Private client-document hosting
- A second embedding index
- Superseded document history or rollback UI
- Automatic correction from Answer Flags
- Paid-tier capacity or multi-provider routing
- Dynamic quota-management UI

## Acceptance criteria

1. Parallel public requests cannot exceed any minute or day allowance, and all four public AI entry points share the same counters.
2. Visitor identifiers are daily one-way values; raw request addresses are never persisted.
3. Production owner operations fail closed when the owner secret is absent or invalid.
4. Confirmed primary daily-quota exhaustion invokes the secondary generation model once without consuming another public action.
5. Streaming fallback never duplicates a partial response, and structured/tool responses retain their existing validation.
6. Embedding failure uses full-text-only retrieval with a visible degraded state while preserving Source References and Insufficient Evidence.
7. A Visitor can flag each issued Portfolio Assistant response at most once, and the Portfolio Owner can review and resolve the flag.
8. A replacement failure leaves the current Project Document searchable; successful activation exposes only the replacement and removes superseded chunks atomically.
9. Automated tests cover allowance concurrency, model routing, degraded retrieval, flag authorization and validation, and replacement activation/failure.
10. The existing migration validation, lint, test, and production build commands pass, followed by the documented real-service smoke test.
