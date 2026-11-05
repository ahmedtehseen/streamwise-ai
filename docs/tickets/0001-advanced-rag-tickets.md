# Ticket 1: Multi-Format Project Document Ingestion Engine

**Label**: `ready-for-agent`
**Parent Spec**: `docs/specs/0001-advanced-rag-personal-portfolio.md`

## Summary
Expand Project Document ingestion beyond `.md` and `.txt` to support **PDF (`.pdf`)**, **HTML (`.html`)**, **JSON (`.json`)**, and **CSV (`.csv`)**, while rejecting unsupported formats like Word (`.docx`).

## Requirements
1. **Database Migration**:
   - Update `project_documents.media_type` check constraint to allow:
     `'text/markdown'`, `'text/plain'`, `'application/pdf'`, `'text/html'`, `'application/json'`, `'text/csv'`.
2. **Text Extractors**:
   - **PDF**: Install and configure a serverless-friendly, pure-JS PDF parser (e.g. `pdf-parse`) to extract UTF-8 text from PDF buffers.
   - **HTML**: Strip HTML markup and scripts/styles, returning clean text passages.
   - **JSON**: Safely parse and format objects/arrays into readable textual key-value lines.
   - **CSV**: Parse CSV rows into readable key-value or row text.
3. **Ingestion Validation (`app/api/knowledge/documents/route.ts`)**:
   - Update `mediaTypeFor` to recognize `.pdf`, `.html`, `.json`, `.csv`.
   - Allow binary buffer extraction for PDF before UTF-8 decoding.
   - Enforce rejection of `.docx` with HTTP 415.
4. **Verification**:
   - Vitest tests verifying upload, extraction, and chunk indexing for PDF, HTML, JSON, and CSV documents.

---

# Ticket 2: Hybrid Search with Reciprocal Rank Fusion (RRF) in PostgreSQL

**Label**: `ready-for-agent`
**Blocked by**: Ticket 1
**Parent Spec**: `docs/specs/0001-advanced-rag-personal-portfolio.md`

## Summary
Upgrade retrieval from single-pass vector search to **Advanced RAG (Hybrid Search)** by combining pgvector and PostgreSQL Full-Text Search (FTS) using Reciprocal Rank Fusion (RRF).

## Requirements
1. **Database Migration**:
   - Add stored generated column `fts` on `document_chunks`:
     `fts tsvector generated always as (to_tsvector('english', array_to_string(heading_path, ' ') || ' ' || text)) stored`
   - Create GIN index on `document_chunks(fts)`.
   - Create or replace function `match_ready_document_chunks_hybrid(p_query_embedding, p_query_text, p_match_count, p_embedding_model, p_embedding_dimension)`.
   - Calculate RRF score: `(1.0 / (60 + vector_rank)) + (1.0 / (60 + fts_rank))`.
   - Return top 5 fused chunks including `cosine_distance` and `fts_rank`.
2. **Deterministic Keyword Extractor**:
   - In `lib/knowledge/server.ts`, add a zero-cost keyword extractor that removes conversational stopwords and formats terms for `websearch_to_tsquery` without invoking Gemini.
3. **Dual-Guardrail Integration**:
   - In `app/api/knowledge/questions/route.ts`, invoke `match_ready_document_chunks_hybrid`.
   - Pass chunks to Gemini if at least one chunk has `cosine_distance <= 0.70` OR a valid keyword match.
   - Immediately return `{ outcome: "insufficient_evidence", paragraphs: [] }` in ~200ms if both fail.
4. **Verification**:
   - Vitest tests verifying exact keyword recall, semantic vector recall, and dual-failure short-circuiting.

---

# Ticket 3: Admin Ingestion Protection & Visitor Portfolio UX

**Label**: `ready-for-agent`
**Blocked by**: Ticket 2
**Parent Spec**: `docs/specs/0001-advanced-rag-personal-portfolio.md`

## Summary
Lock down document mutation endpoints to the portfolio owner via `ADMIN_SECRET` and tailor the client-side UI for public visitors.

## Requirements
1. **Admin Authorization**:
   - Protect `POST /api/knowledge/documents`, `DELETE /api/knowledge/documents/[id]`, and retry routes with `ADMIN_SECRET` (validated via `x-admin-key` header or query parameter).
   - If `ADMIN_SECRET` is configured and request lacks valid authorization, return HTTP 401.
   - `POST /api/knowledge/questions` remains publicly accessible.
2. **Visitor-Centric UI (`app/knowledge-panel.tsx`)**:
   - When not in admin mode, hide file upload inputs and document deletion buttons.
   - Add sample question chips/pills for visitors (e.g. *"What are your core technical skills?"*, *"Tell me about a complex project you led"*, *"What is your experience with database optimization?"*).
3. **Verification**:
   - Test unauthorized upload/delete rejections.
   - Test authorized uploads with admin key.
   - Full regression test run: `npm test`.

