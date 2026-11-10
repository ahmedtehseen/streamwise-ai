# Streamwise AI

Streamwise AI turns project material into structured, reviewable work and source-backed project knowledge.

Built with Next.js (App Router, Turbopack), the Google Gemini API, Supabase Postgres with `pgvector`, and TypeScript.

---

## Capabilities & Modes

The application features three integrated modes. Streamwise is a single-owner public portfolio product: Visitors use the public capabilities anonymously, while one Portfolio Owner manages the Knowledge Base with a revocable secret.

1. **Chat (Streaming Chat)**
   - Streams Gemini model responses chunk-by-chunk using web `ReadableStream` through a private server endpoint (`POST /api/chat`).
   - Persists conversation history locally in the browser with local storage, restoring thread context across refreshes.
   - Sends recent conversation history with each turn to maintain conversational memory.

2. **Spec (Structured Task Specifications & Approved Tool Calling)**
   - **Text & Multimodal Intake**: Accepts written requirements or attached screenshots (PNG, JPEG, WebP up to 5 MB) via paste or file picker (`POST /api/task-spec`).
   - **Guaranteed Output Schema**: Gemini returns structured JSON enforced with a strict response schema and validated on the server with Zod.
   - **Human-in-the-Loop Tool Calling**: An explicit **Create draft task** action prompts a Gemini tool-call request (`create_task_draft`), strictly validating arguments against the approved spec before saving a local draft receipt (`POST /api/task-draft`).
   - **Draft Task Management**: Review, copy as Markdown, open, or delete drafts directly from the sidebar.

3. **Portfolio Assistant (Advanced RAG)**
   - **Multi-Format Ingestion**: Ingests Project Documents in Markdown (`.md`, `.markdown`), plain text (`.txt`), PDF (`.pdf`), HTML (`.html`, `.htm`), JSON (`.json`), and CSV (`.csv`) up to 500 KB (512,000 bytes) with automatic text extraction, heading-aware chunking, and deduplication.
   - **Advanced RAG (Hybrid Search with RRF)**: Combines semantic vector similarity (`gemini-embedding-2`, 768 dimensions) and PostgreSQL full-text search (`tsvector` with GIN indexing) via Reciprocal Rank Fusion (RRF) in Supabase.
   - **Dual-Guardrail Pre-Check**: Short-circuits queries without relevant semantic similarity (cosine distance $\le 0.70$) or keyword matches directly to **Insufficient Evidence** in ~200ms, preserving Gemini API quota and minimizing latency.
   - **Grounded Answers & Source References**: Returns factual answers strictly grounded in retrieved evidence. Visitors can inspect interactive **Source References** showing the Project Document name, heading path, line range, and stored excerpt.
   - **Portfolio Owner Access Control**: Secures Project Document mutation endpoints (upload, retry, delete) via `ADMIN_SECRET` (`x-admin-key`), while providing Visitors with an accessible Portfolio Assistant.
   - **Reviewable Answer Flags**: Gives every Grounded Answer and Insufficient Evidence response a signed identity so Visitors can submit one anonymous, optional-note flag for private owner review without changing evidence or behavior automatically.
   - **Safe Document Replacement**: Stages one candidate revision while the current ready Project Document remains searchable, then atomically activates the candidate and removes superseded evidence only after successful processing.

All four public AI actions share one durable allowance: 3 actions per Visitor per minute, 15 globally per minute, 10 per Visitor per Pacific day, and 50 globally per Pacific day. Limit responses identify the reset time in Pacific time. A Chat message, Spec generation, task-draft creation, or Portfolio Assistant question consumes one action; navigation, Answer Flags, and owner-only indexing do not. Malformed requests are rejected before admission, and an internal model fallback does not consume another action. Portfolio Assistant configuration checks and checks for ready Project Documents also run before admission.

Generation uses `gemini-3.5-flash-lite` first. Confirmed daily-quota exhaustion permits one compatible `gemini-3.1-flash-lite` attempt within the admitted action; short-window throttling receives one bounded retry. A partial Chat stream is never restarted, and the same output validation applies to either model. If both models exhaust daily quota, Streamwise returns a stable unavailable response without provider details.

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
| `ADMIN_SECRET` | Owner operations | High-entropy Portfolio Owner secret required to upload, retry, replace, or delete Project Documents and to review Answer Flags. Production fails closed when it is absent or invalid; leaving it unset is a local-development convenience only. |
| `MCP_OWNER_TOKEN` | Owner MCP review | Dedicated high-entropy server-only bearer token (at least 32 non-whitespace characters) for `/api/mcp/owner` Answer Flag reads and review. It must be distinct from `ADMIN_SECRET`; the owner MCP endpoint fails closed in every environment when it is absent, malformed, or incorrect. |
| `ANSWER_FLAG_SECRET` | Optional | Dedicated server-only secret for signing response identities. When omitted, the service-role key is used as the signing key source. |
| `VISITOR_ID_SECRET` | Public AI routes | Server-only high-entropy secret of at least 32 characters, used to derive rotating one-way Visitor identifiers from Vercel's trusted client-address header. |
| `SUPABASE_DB_URL` | Optional | Direct Postgres connection URI (optional; used by `scripts/apply-migration.mjs`). |

> [!IMPORTANT]
> Never commit `.env.local` or expose `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`, `MCP_OWNER_TOKEN`, `ANSWER_FLAG_SECRET`, or `VISITOR_ID_SECRET` in client components, public assets, logs, API responses, URLs, tool arguments, or `NEXT_PUBLIC_` variables. Only server-side routes use provider credentials. The Portfolio Owner enters `ADMIN_SECRET` at runtime; the application does not embed it in browser assets. MCP clients supply `MCP_OWNER_TOKEN` only through the standard `Authorization: Bearer` header.

Streamwise does not implement Visitor accounts, multi-user workspaces, project-scoped permissions, or per-document authorization. The configured free Gemini tier may use submitted data to improve Google products, so this deployment does not claim suitability for private client information.

### Week 7 MCP access

Streamwise exposes four tools over stateless Streamable HTTP, using the same Portfolio Assistant and Answer Flag application services as the existing interface and API.

| Endpoint | Tool | Scope |
| --- | --- | --- |
| `/api/mcp` | `ask_portfolio` | Public question of 1–500 trimmed characters. Returns a Grounded Answer with Source References, Insufficient Evidence, or a sanitized error. |
| `/api/mcp/owner` | `list_answer_flags` | Owner-only summaries filtered by `open` or `reviewed`, with a cursor and a page limit of 1–50 (default 20). |
| `/api/mcp/owner` | `get_answer_flag` | Owner-only inspection of one exact `flagId` UUID and its immutable response snapshot. |
| `/api/mcp/owner` | `review_answer_flag` | Owner-only transition of one exact open `flagId` UUID to reviewed after explicit Portfolio Owner approval in Codex. |

`ask_portfolio` consumes the same durable Visitor/global public allowance as the four web AI actions. It reuses grounding, Source References, Insufficient Evidence, degraded retrieval, and sanitized limit/reset outcomes. Production must supply the trusted Vercel client-address header and `VISITOR_ID_SECRET` for public calls. Missing trusted Visitor identity fails closed. Owner tools consume no public action and invoke no model.

Codex is the supported Week 7 client. Add the public endpoint to the same trusted Codex configuration as the owner example below, replacing the example origin with the deployed HTTPS origin.

```toml
[mcp_servers.streamwise_public]
url = "https://streamwise.example/api/mcp"
enabled_tools = ["ask_portfolio"]
```

Owner discovery and initialization require the dedicated `MCP_OWNER_TOKEN` bearer credential before any tool runs. `ADMIN_SECRET` continues to authorize existing owner interface/API operations. The owner MCP tools expose only Answer Flag listing, inspection, and review. Week 7 defers OAuth, additional client compatibility, document administration through MCP, autonomous workflows, and Week 8 evaluation and observability.

#### Owner tool failures

Owner tool failures return `isError = true`. Both `structuredContent` and the first text content item carry the same JSON payload. Clients can branch on `error.code` and `error.retryable`.

```json
{
  "ok": false,
  "outcome": "error",
  "error": {
    "code": "answer_flag_not_found",
    "message": "The Answer Flag could not be found.",
    "retryable": false
  }
}
```

| Code | Meaning | Retryable |
| --- | --- | --- |
| `invalid_answer_flag_query` | Invalid tool arguments, identifier, page, cursor, or tool name | No |
| `answer_flag_not_found` | The requested snapshot is absent | No |
| `answer_flag_conflict` | The atomic review found no open flag, including missing or already-reviewed flags | No |
| `answer_flags_unavailable` | Answer Flag storage could not complete the operation | Yes |
| `answer_flags_not_configured` | Answer Flag server configuration is unavailable | Yes |

Schema failures use a fixed message without echoing rejected values. Service messages omit database/provider detail and credentials. HTTP 401 still rejects unauthorized requests before MCP initialization, discovery, or calls.

#### Codex owner MCP configuration

Codex is the supported Week 7 owner MCP client. Export the same dedicated token configured as `MCP_OWNER_TOKEN` on the Streamwise deployment into the environment that launches Codex, then add the following to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`). Replace the example origin with the HTTPS Streamwise deployment:

```toml
approvals_reviewer = "user"

[mcp_servers.streamwise_owner]
url = "https://streamwise.example/api/mcp/owner"
bearer_token_env_var = "MCP_OWNER_TOKEN"
enabled_tools = ["list_answer_flags", "get_answer_flag", "review_answer_flag"]
default_tools_approval_mode = "prompt"

[mcp_servers.streamwise_owner.tools.review_answer_flag]
approval_mode = "prompt"
```

This configuration uses Codex's environment-sourced bearer-token support, restricts discovery to the three owner Answer Flag tools, assigns approval review to the user, and requires a prompt for every `review_answer_flag` call. The owner should inspect the Answer Flag first and approve only when the prompt contains the exact UUID shown by `list_answer_flags` or `get_answer_flag`. Do not replace `prompt` with `approve`, create a saved blanket approval, put the token in the URL or configuration file, or reuse `ADMIN_SECRET`.

Codex supplies the approval interaction; Streamwise receives only the subsequent tool call. Streamwise therefore cannot unit-test Codex's approval UI. It instead rechecks the bearer credential, exact UUID, and current open state on every call. MCP tool annotations accurately advertise `review_answer_flag` as a write, but annotations are hints and are not authorization or an approval control. See the official [Codex MCP configuration](https://developers.openai.com/codex/mcp), [Codex configuration reference](https://developers.openai.com/codex/config-reference), and [MCP tool annotation guidance](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations).

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
9. `202611060004_capture_answer_flags.sql`
10. `202611060005_align_portfolio_assistant_language.sql`
11. `202611060006_preserve_answer_response_identity.sql`

Apply incremental migrations to an existing project with the Supabase SQL Editor. For a new empty project, the helper applies the complete ordered set in one transaction and refuses to run when Streamwise application tables already exist:
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
- Answer Flag identity verification, Grounded Answer and Insufficient Evidence capture, degraded responses, duplicate prevention, note limits, owner authorization, and review transitions.
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

The canonical Week 6 specification and tickets live in GitHub: [#9](https://github.com/ahmedtehseen/streamwise-ai/issues/9), with implementation tickets [#10](https://github.com/ahmedtehseen/streamwise-ai/issues/10) through [#15](https://github.com/ahmedtehseen/streamwise-ai/issues/15). Follow [the complete Week 6 real-service smoke procedure](docs/real-service-smoke.md) against the configured Supabase project and Gemini API. It covers shared Visitor/global allowance outcomes, primary generation and compatible fallback, visibly degraded retrieval, Grounded Answers and Insufficient Evidence, Answer Flag submission and owner review, failed replacement isolation, successful atomic activation, cascading cleanup, and removal of all temporary smoke data. The latest recorded execution is [the 2026-11-06 Week 6 smoke record](docs/smoke/2026-11-06-week6.md).

For Week 7, follow [the HTTPS and Codex MCP smoke procedure](docs/week7-mcp-smoke.md). The [2026-11-10 Week 7 record](docs/smoke/2026-11-10-week7.md) separates deterministic gate results from blocked live observations.

The allowance concurrency check is destructive to `public_allowance_buckets` and therefore requires a separately configured isolated database. Never run it against production:

```sh
PUBLIC_ALLOWANCE_TEST_DATABASE_URL='<isolated migrated database>' \
PUBLIC_ALLOWANCE_TEST_CONFIRM=clear-test-buckets \
npm run allowance:verify
```

---

## Progressive Milestones Overview

- **Week 1 · Streaming Chat & Conversational Memory**: Browser-to-server SSE streaming, private server-side key management, web `ReadableStream` decoding, and client-side conversation persistence.
- **Week 2 · Structured Outputs & Task Specifications**: Non-streaming JSON generation using Gemini response schemas, server-side Zod validation, and editable task cards.
- **Week 3 · Approved Tool Calling & Local Drafts**: Human approval gate triggering function calling (`create_task_draft`), input/output schema validation, and local draft receipt management.
- **Week 4 · Multimodal Screenshot Intake**: Direct screenshot upload and paste (PNG/JPEG/WebP up to 5 MB), vision analysis, and conversion to structured task specifications.
- **Week 5 · Portfolio Assistant & Advanced RAG**: Shared Knowledge Base with Supabase Postgres and `pgvector`, multi-format Project Document ingestion, hybrid search with Reciprocal Rank Fusion, deterministic keyword extraction, Portfolio Owner protection, and source-grounded answers.
- **Week 6 · Trustworthy public Streamwise**: Shared public allowances, visibly degraded full-text retrieval, reviewable Answer Flags, and safe Document Replacement.
- **Week 7 · Bounded MCP access**: Public Portfolio Assistant questions and credential-protected Answer Flag inspection/review through Codex, with explicit approval before review. Live acceptance status is tracked in the Week 7 smoke record.

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
│   │       ├── answer-flags/                   # Visitor submission and owner review endpoints
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
│       ├── answer-flags.ts                    # Signed response identity creation and verification
│       ├── extractors.ts                      # Multi-format parsers (PDF, HTML, JSON, CSV)
│       ├── indexing.ts                        # Chunk embedding & vector preparation
│       └── server.ts                          # Supabase client, hybrid search, & Portfolio Owner authorization
├── scripts/
│   ├── apply-migration.mjs                    # Direct migration runner
│   └── validate-migrations.mjs                # Migration invariant & ordering validator
├── supabase/
│   ├── migrations/                            # Versioned schema migrations
│   └── verify_knowledge_schema.sql            # Read-only post-migration schema verification
├── docs/                                      # ADRs, historical plans, smoke proof, and agent guidelines
└── GLOSSARY.md                                # Official domain language & terminology
```
