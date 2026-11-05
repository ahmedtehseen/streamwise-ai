# Streamwise AI

Streamwise AI turns project material into structured, reviewable work and source-backed project knowledge.

Built with Next.js (App Router, Turbopack), the Google Gemini API, Supabase Postgres with `pgvector`, and TypeScript.

---

## Capabilities & Modes

The application features three integrated modes:

1. **Chat (Streaming Chat)**
   - Streams Gemini model responses chunk-by-chunk using web `ReadableStream` through a private server endpoint (`POST /api/chat`).
   - Persists conversation history locally in the browser with local storage, restoring thread context across refreshes.
   - Sends recent conversation history with each turn to maintain conversational memory.

2. **Spec (Structured Task Specifications & Approved Tool Calling)**
   - **Text & Multimodal Intake**: Accepts written requirements or attached screenshots (PNG, JPEG, WebP up to 5 MB) via paste or file picker (`POST /api/task-spec`).
   - **Guaranteed Output Schema**: Gemini returns structured JSON enforced with a strict response schema and validated on the server with Zod.
   - **Human-in-the-Loop Tool Calling**: An explicit **Create draft task** action prompts a Gemini tool-call request (`create_task_draft`), strictly validating arguments against the approved spec before saving a local draft receipt (`POST /api/task-draft`).
   - **Draft Task Management**: Review, copy as Markdown, open, or delete drafts directly from the sidebar.

3. **Knowledge (Project Knowledge Assistant & Advanced RAG)**
   - **Multi-Format Ingestion**: Ingests Project Documents in Markdown (`.md`, `.markdown`), plain text (`.txt`), PDF (`.pdf`), HTML (`.html`, `.htm`), JSON (`.json`), and CSV (`.csv`) up to 500 KB (512,000 bytes) with automatic text extraction, heading-aware chunking, and deduplication.
   - **Advanced RAG (Hybrid Search with RRF)**: Combines semantic vector similarity (`gemini-embedding-2`, 768 dimensions) and PostgreSQL full-text search (`tsvector` with GIN indexing) via Reciprocal Rank Fusion (RRF) in Supabase.
   - **Dual-Guardrail Pre-Check**: Short-circuits queries without relevant semantic similarity (cosine distance $\le 0.70$) or keyword matches directly to **Insufficient Evidence** in ~200ms, preserving Gemini API quota and minimizing latency.
   - **Grounded Answers & Source References**: Returns factual answers strictly grounded in retrieved evidence. Users can inspect interactive **Source References** showing the document name, heading path, line range, and stored excerpt.
   - **Portfolio Owner Access Control**: Secures Project Document mutation endpoints (upload, retry, delete) via `ADMIN_SECRET` (`x-admin-key`), while providing Visitors with an accessible Portfolio Assistant.
   - **Safe Document Replacement**: Stages one candidate revision while the current ready Project Document remains searchable, then atomically activates the candidate and removes superseded evidence only after successful processing.

All four public AI actions share one durable allowance: 3 actions per Visitor per minute, 15 globally per minute, 10 per Visitor per Pacific day, and 50 globally per Pacific day. Limit responses identify the reset time in Pacific time.

---

## Getting Started

### Prerequisites

- **Node.js**: `22.13.0` or newer (`npm ci` recommended)
- **Google Gemini API Key**: For text generation, multimodal vision, and `gemini-embedding-2`
- **Supabase Project**: With PostgreSQL and the `pgvector` extension (required for Knowledge mode)

### 1. Installation

Install exact locked dependencies:

```sh
npm ci
```

### 2. Environment Configuration

Copy `.env.example` (or `.env.local.example`) to `.env.local`:

```sh
cp .env.example .env.local
```

Configure the following server-side environment variables in `.env.local`:

| Variable | Required For | Description |
|---|---|---|
| `GEMINI_API_KEY` | All modes | Gemini API key for chat streaming, structured specs, multimodal vision, embeddings, and grounded answers. |
| `SUPABASE_URL` | Knowledge | Project URL from Supabase **Project Settings → API**. |
| `SUPABASE_SERVICE_ROLE_KEY` | Knowledge | Privileged service-role secret from Supabase **Project Settings → API** (server-only). |
| `ADMIN_SECRET` | Knowledge | Shared owner key required to upload, retry, or delete Project Documents. Leave unset only for open local testing. |
| `VISITOR_ID_SECRET` | Public AI routes | Server-only high-entropy secret of at least 32 characters, used to derive rotating one-way Visitor identifiers from Vercel's trusted client-address header. |
| `SUPABASE_DB_URL` | Optional | Direct Postgres connection URI (optional; used by `scripts/apply-migration.mjs`). |

> [!IMPORTANT]
> Never commit `.env.local` or expose `SUPABASE_SERVICE_ROLE_KEY` or `ADMIN_SECRET` in client components or through `NEXT_PUBLIC_` variables. Row-level security is enforced on the database, and only server-side routes interact with Supabase.

### 3. Database Migrations (for Knowledge mode)

Apply the versioned migrations located in `supabase/migrations/` in ascending order:

1. `202611030001_create_knowledge_base.sql`
2. `202611030002_manage_project_documents.sql`
3. `202611030003_match_ready_document_chunks.sql`
4. `202611030004_recover_document_indexing.sql`
5. `202611040001_multi_format_and_hybrid_search.sql`
6. `202611060001_enforce_public_allowance.sql`
7. `202611060002_degraded_full_text_retrieval.sql`
8. `202611060003_replace_project_documents.sql`

You can apply them using the Supabase SQL Editor or via the script:
```sh
node scripts/apply-migration.mjs
```

Verify migration ordering and schema invariants:

```sh
npm run migrations:validate
```

Optionally, run `supabase/verify_knowledge_schema.sql` in the Supabase SQL editor to confirm that all required functions, vector configurations, and RLS policies are active.

### 4. Run the Development Server

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Verification & Testing

Run the complete verification suite:

```sh
npm run migrations:validate # Verify Supabase migration schema invariants
npm run lint                # Run ESLint across app and lib
npm test                    # Run Vitest unit and integration suite
npm run build               # Verify Next.js production build
```

The automated test suite verifies:
- Multi-format file validation, text extraction, and rejection of unsupported formats (e.g., `.docx`).
- Chunk indexing, content fingerprinting, deduplication, and capacity enforcement (20 documents).
- Ready-only hybrid retrieval plus explicit full-text-only degradation when Embedding 2 is temporarily unavailable.
- Grounded Answer synthesis, Insufficient Evidence boundaries, and citation validation.
- Portfolio Owner authorization enforcement on Project Document upload, retry, and deletion endpoints.
- Document Replacement success, failure isolation, retry, discard, concurrency, full-capacity, duplicate, authorization, activation, and cleanup behavior.
- Shared public allowance admission, missing Visitor identity, durable-storage failure, and minute/day reset responses at all four API seams.
- Error handling for transient database and Gemini provider failures.

---

## Knowledge Base Requirements & Invariants

- **Supported Formats**:
  - Markdown (`.md`, `.markdown`)
  - Plain text (`.txt`)
  - PDF (`.pdf`) — extracted server-side via `unpdf`
  - HTML (`.html`, `.htm`) — sanitized text extraction
  - JSON (`.json`) — structured textification
  - CSV (`.csv`) — tabular textification
- **File Limits**: Maximum 500 KB (512,000 bytes) per document. Word documents (`.docx`), executables, and empty files are rejected with HTTP 415 or 400.
- **Knowledge Base Capacity**: The shared Knowledge Base holds at most 20 Project Documents (including indexing and failed records).
- **Embedding Invariants**:
  - Model: `gemini-embedding-2`
  - Dimensions: 768
  - Prefix convention: `Document: ` for Project Document passages; `Query: ` for search queries.
  - Vectors produced with different models or prefixes must never be mixed.
- **Hybrid Retrieval**:
  - Vector similarity using cosine distance operator (`<=>`).
  - Full-text search using `tsvector` generated column (`chunk_to_tsvector`) and GIN index.
  - Reciprocal Rank Fusion: $RRF = \frac{1}{60 + r_{\text{vector}}} + \frac{1}{60 + r_{\text{fts}}}$.
  - Returns top 5 fused chunks.
- **Degraded Retrieval**:
  - Eligible temporary Embedding 2 failures use only PostgreSQL full-text search over ready Project Documents.
  - The API and Knowledge interface disclose reduced-recall keyword search.
  - No keyword match returns Insufficient Evidence without invoking answer generation.
  - Authentication failures and invalid or incompatible vectors never trigger degradation.

---

## Real-Service Smoke Test

Before the integrated workflow, run `PUBLIC_ALLOWANCE_TEST_CONFIRM=clear-test-buckets npm run allowance:verify` against an isolated test database configured in `PUBLIC_ALLOWANCE_TEST_DATABASE_URL`. The check temporarily clears only `public_allowance_buckets`, sends parallel admissions, proves that exactly 3 same-Visitor and 15 global requests are admitted, validates Pacific reset boundaries, and clears the test buckets afterward. Never point this check at production.

Perform this procedure against a configured private Supabase project and Gemini API to verify the integrated end-to-end workflow:

1. **Start Empty**: Open **Knowledge**. Ensure the Knowledge Base is empty or delete existing test documents. Confirm "Loading the Knowledge Base…" resolves to the empty state.
2. **Upload Markdown Document**: Save and upload `atlas.md` with the content below. Confirm status transitions from **indexing** to **ready**.

   ```markdown
   # Atlas

   ## Release schedule

   Atlas production deployments happen every Friday.
   Release review begins at 14:00 UTC.
   ```

3. **Upload Text Document**: Save and upload `operations.txt` with the content below. Confirm status transitions from **indexing** to **ready**.

   ```text
   The Atlas incident commander is the on-call platform engineer.

   Customer status updates are posted every thirty minutes during an incident.
   ```

4. **Verify Grounded Answer**: Ask: `When does Atlas deploy and when does release review begin?`
   - Observe **Searching…**, followed by a Grounded Answer.
   - Confirm each factual paragraph has a **Source Reference** pointing to `atlas.md`.
   - Select the reference to inspect the heading path, line range, and excerpt.
5. **Verify Insufficient Evidence Boundary**: Ask: `What is Atlas's annual infrastructure budget?`
   - Confirm the result is **Insufficient Evidence** with no hallucinated answers or references.
6. **Verify Degraded Retrieval**: With the configured Gemini project returning an eligible temporary Embedding 2 failure (HTTP 408, 429, or 5xx), ask: `When does Atlas production deploy?`
   - Confirm the interface says semantic search is temporarily unavailable and keyword results may be less complete.
   - Confirm the Grounded Answer still cites the exact `atlas.md` passage.
   - Ask: `What is Atlas's annual infrastructure budget?` and confirm degraded Insufficient Evidence is returned without an answer.
   - Confirm an authentication failure or an invalid-dimension embedding returns an error instead of entering degraded search.
7. **Verify Duplicate Rejection**: Upload the unchanged `atlas.md` again (renaming the file is allowed; changing byte content is not). Confirm duplicate content is rejected.
8. **Test Transient Failure Handling**: In the Supabase SQL editor, run:

   ```sql
   update public.project_documents
   set status = 'failed',
       failure_detail = 'Manual transient failure for smoke test.',
       failure_retryable = true,
       updated_at = now()
   where name = 'operations.txt' and status = 'ready';
   ```

   Reload Knowledge. Confirm `operations.txt` displays **failed**, the failure detail is visible, and **Retry indexing** is offered.
9. **Test Retry**: Choose **Retry indexing**. Confirm the status transitions through **Retrying…** / **indexing** to **ready**.
10. **Test Cascading Deletion**: Copy the document ID: `select id from public.project_documents where name = 'operations.txt';`. Delete `operations.txt` in the UI. Confirm it disappears from the list, and verify in SQL that chunks were deleted:

   ```sql
   select count(*) from public.document_chunks where project_document_id = '<copied-id>'::uuid;
   ```

   The count must be `0`.
11. **Multi-Mode Integration**: Switch to **Chat**, send a message, and verify streaming. Switch to **Spec**, submit a prompt, and verify the editable task card. Return to **Knowledge** and confirm document status remains consistent.
12. **Verify Safe Replacement**: Choose **Replace** for `atlas.md` and submit a changed revision. During processing, ask a question supported only by the current revision and confirm it remains available. Confirm successful processing swaps the displayed revision. For atomic database proof, verify the new ready row and chunks exist while the superseded row and chunks do not; repeat with a forced embedding failure and confirm the current ready row and chunks remain unchanged, then retry or discard the failed candidate.

---

## Progressive Milestones Overview

- **Week 1 · Streaming Chat & Conversational Memory**: Browser-to-server SSE streaming, private server-side key management, web `ReadableStream` decoding, and client-side conversation persistence.
- **Week 2 · Structured Outputs & Task Specifications**: Non-streaming JSON generation using Gemini response schemas, server-side Zod validation, and editable task cards.
- **Week 3 · Approved Tool Calling & Local Drafts**: Human approval gate triggering function calling (`create_task_draft`), input/output schema validation, and local draft receipt management.
- **Week 4 · Multimodal Screenshot Intake**: Direct screenshot upload and paste (PNG/JPEG/WebP up to 5 MB), vision analysis, and conversion to structured task specifications.
- **Week 5 · Project Knowledge Assistant & Advanced RAG**: Shared Knowledge Base with Supabase Postgres and `pgvector`, multi-format document ingestion, hybrid search with Reciprocal Rank Fusion, deterministic keyword extraction, dual-guardrail pre-checks, admin ingestion protection, and source-grounded answers.
- **Week 6 · Trustworthy public Streamwise**: Shared public allowances and visibly degraded full-text retrieval that preserves Grounded Answers, Source References, and Insufficient Evidence.

---

## Project Structure

```text
├── app/
│   ├── api/
│   │   ├── chat/route.ts                      # Streaming chat endpoint (Gemini API)
│   │   ├── task-spec/route.ts                 # Structured task specification endpoint (text & vision)
│   │   ├── task-draft/route.ts                # Function calling draft creation endpoint
│   │   └── knowledge/
│   │       ├── documents/route.ts             # Project Document upload & listing endpoint
│   │       ├── documents/[documentId]/        # Document deletion and retry endpoints
│   │       └── questions/route.ts             # Hybrid search & Grounded Answer endpoint
│   ├── globals.css                            # Responsive styling & themes
│   ├── knowledge-panel.tsx                    # Knowledge Base UI, drawer, & visitor Q&A
│   ├── layout.tsx                             # Root layout & metadata
│   └── page.tsx                               # Multi-mode navigation, chat, spec, & drafts
├── lib/
│   ├── image-upload.ts                        # Screenshot intake validation & limits
│   ├── task-spec.ts                           # Zod schemas for task specifications & drafts
│   └── knowledge/
│       ├── chunks.ts                          # Document chunking & heading extraction
│       ├── extractors.ts                      # Multi-format parsers (PDF, HTML, JSON, CSV)
│       ├── indexing.ts                        # Chunk embedding & vector preparation
│       └── server.ts                          # Supabase client, hybrid search, & admin auth
├── scripts/
│   ├── apply-migration.mjs                    # Direct migration runner
│   └── validate-migrations.mjs                # Migration invariant & ordering validator
├── supabase/
│   ├── migrations/                            # Versioned schema migrations
│   └── verify_knowledge_schema.sql            # Read-only post-migration schema verification
├── docs/                                      # ADRs, specs, tickets, and agent guidelines
└── GLOSSARY.md                                # Official domain language & terminology
```
