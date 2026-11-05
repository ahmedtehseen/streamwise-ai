# Specification: Advanced RAG Personal Portfolio Knowledge Base

## Status
Approved

## Context & Objectives
Streamwise AI's **Project Knowledge Assistant** is evolving from a single-tenant document search tool into an interactive, source-grounded personal portfolio and professional knowledge agent.

The system will allow the portfolio owner to ingest comprehensive career materials—including PDFs, Markdown case studies, HTML articles, JSON exports, and CSV benchmarks—while public visitors can ask questions and receive factual, citation-backed **Grounded Answers** with zero hallucinations.

To achieve fast, high-precision retrieval across both technical keywords (e.g. "Next.js", "pgvector", "Docker") and broad conceptual inquiries (e.g. "leadership approach", "complex debugging"), the retrieval architecture will be upgraded to **Advanced RAG (Hybrid Search with Reciprocal Rank Fusion)** in PostgreSQL.

---

## Glossary & Domain Language
All implementations must strictly follow `GLOSSARY.md`:
* **Project Knowledge Assistant**: The system answering questions using the Knowledge Base.
* **Knowledge Base**: The collection of indexed Project Documents.
* **Project Document**: A career asset (PDF, MD, TXT, HTML, JSON, CSV).
* **Grounded Answer**: A response strictly derived from retrieved evidence with Source References.
* **Insufficient Evidence**: The outcome when documents do not support an answer.
* **Source Reference**: A link from an answer paragraph to an exact Project Document passage.

---

## Architecture & System Design

### 1. Multi-Format Project Document Ingestion
* **Allowed Media Types**:
  * `text/markdown` (`.md`)
  * `text/plain` (`.txt`)
  * `application/pdf` (`.pdf`) — extracted via server-side PDF text parser
  * `text/html` (`.html`, `.htm`) — sanitized text extraction
  * `application/json` (`.json`) — structured JSON textification
  * `text/csv` (`.csv`) — tabular row-by-row textification
* **Rejected Types**: Binary formats other than PDF (e.g., `.docx`, executables, images) must return HTTP 415.
* **Database Constraint**: Update check constraint on `project_documents.media_type` to allow these media types.

### 2. Advanced RAG: Hybrid Search with Reciprocal Rank Fusion (RRF)
* **Full-Text Indexing**:
  * Stored generated column `fts tsvector generated always as (to_tsvector('english', array_to_string(heading_path, ' ') || ' ' || text)) stored` on `document_chunks`.
  * GIN index on `document_chunks(fts)`.
* **Zero-Cost Keyword Extraction**:
  * Clean conversational stopwords in TypeScript/Node.js to extract entities and technical terms formatted for PostgreSQL `websearch_to_tsquery`.
  * Requires 0 extra LLM calls, preserving Gemini API free-tier quotas and adding < 0.1ms latency.
* **Reciprocal Rank Fusion SQL RPC (`match_ready_document_chunks_hybrid`)**:
  * Retrieves Top 10 by semantic cosine distance (`<=>`).
  * Retrieves Top 10 by keyword rank (`ts_rank_cd`).
  * Computes fused score: $RRF = \frac{1}{60 + r_{\text{vector}}} + \frac{1}{60 + r_{\text{keyword}}}$.
  * Returns the Top 5 fused chunks.
* **Dual-Guardrail Pre-Check**:
  * Proceed to Gemini generation if at least one chunk has `cosine_distance <= 0.70` OR a keyword match hit.
  * If both fail, immediately return `Insufficient Evidence` in ~200ms without invoking Gemini.

### 3. Admin Access Control & Visitor UX
* **Protected Ingestion**:
  * `POST /api/knowledge/documents` and document deletion routes check for `ADMIN_SECRET` (via `x-admin-key` header or cookie).
  * If invalid or missing, return HTTP 401 Unauthorized.
* **Public Q&A**:
  * `POST /api/knowledge/questions` remains public.
  * Visitor UI displays portfolio introductory context, quick-prompt pills, and grounded answers, while hiding document management forms from unauthorized visitors.

---

## Non-Goals
* Word Document (`.docx`) parsing (explicitly excluded).
* Multi-agent iterative planning loop (Agentic RAG deferred).
* External paid cross-encoder rerankers (Cohere, etc.) — all ranking must remain in Postgres RRF.

---

## Verification & Acceptance Criteria
1. **Multi-Format Ingestion**:
   - Successfully uploads and indexes `.pdf`, `.html`, `.json`, `.csv`, `.md`, and `.txt`.
   - Rejects `.docx` and raw binary files with HTTP 415.
2. **Hybrid Search Accuracy**:
   - Exact keyword queries (e.g. error codes, specific acronyms) match via FTS even if semantic distance is high.
   - Conceptual queries match via pgvector.
   - Off-topic questions return `Insufficient Evidence` in < 300ms without calling Gemini.
3. **Security**:
   - Unauthenticated visitors cannot upload or delete Project Documents.
4. **Test Suite**:
   - All existing tests continue to pass; new unit and integration tests cover PDF extraction, hybrid RPC, and admin protection.

