# Streamwise AI learning project

This app teaches the basic AI integration loop:

1. The browser sends the current conversation thread to `POST /api/chat`.
2. The server keeps the Gemini key private and starts a streaming model request.
3. The route turns model chunks into a web `ReadableStream`.
4. The browser reads that stream and appends each chunk to the response.
5. Conversations are saved in browser local storage, and the selected thread is sent back as context on the next message.

## Run it

1. Install dependencies: `npm install`
2. Create a `.env.local` file in the project root.
3. Put your real Gemini API key in it as `GEMINI_API_KEY=your_key_here`. Never put it in a client component or commit `.env.local`.
4. Start the app: `npm run dev`
5. Visit `http://localhost:3000` and ask a question.

## Important files

- `app/page.tsx` — browser UI and stream reader.
- `app/api/chat/route.ts` — private server endpoint; it calls Gemini and converts its SSE stream into plain text for the browser.
- `.env.local` — your local secret, intentionally ignored by Git.

## Conversation storage

This learning project saves its conversation list locally in the browser, so it persists after a page refresh on this device. It does not yet use a database, authentication, or cross-device sync.

## Week 2 milestone: structured, editable task specifications

Turn on **Spec** mode, enter a product or engineering request, then use the send button. In standard mode the send button continues the streaming chat; in Spec mode it calls `POST /api/task-spec`, which asks Gemini for JSON using a response schema, validates the parsed result with Zod on the server, and returns an editable task card with title, priority, acceptance criteria, and implementation notes. This demonstrates the production pattern for AI output that an interface or downstream system needs to rely on: request a defined shape, then validate it anyway before using it.

It uses the existing `GEMINI_API_KEY`; no database, authentication, or new service is required. The spec route is intentionally non-streaming because the browser only renders it after the whole JSON document has been parsed and validated.

## What to experiment with

- Change the system message in `app/api/chat/route.ts` and see how output changes.
- Add a character limit before the API request.
- Notice that the server sends the latest 20 messages to Gemini on each request; this is the basic form of conversational memory.

## Week 5 milestone: Grounded Answers

Knowledge mode introduces a shared private Knowledge Base backed by Supabase Postgres and pgvector. After a Project Document is ready, a question retrieves the five closest ready passages and returns either a structured Grounded Answer or Insufficient Evidence. Select a Source Reference to inspect its trusted document name, heading path, line range, and stored excerpt.

This milestone is intentionally a private, local workflow with one shared Knowledge Base. It has no authentication, user ownership, or document permissions. Do not expose Knowledge mode publicly; those access boundaries belong to Week 6.

### Requirements and limits

- Node.js 22.13 or newer and npm.
- A private Supabase project and a Gemini API key.
- UTF-8 Markdown (`.md` or `.markdown`, `text/markdown`) and plain text (`.txt`, `text/plain`) are the only accepted formats. Empty, binary-looking, unsupported, and larger-than-500-KB (512,000-byte) uploads are rejected.
- The shared Knowledge Base holds at most 20 Project Documents, including indexing and failed records.
- Every stored vector uses `gemini-embedding-2`, 768 dimensions, `Document: ` for Project Document passages, and `Query: ` for questions. Changing the model, dimension, or prefix convention requires re-indexing every Project Document; vectors produced with different invariants must never be mixed.

### Fresh-checkout setup

1. Use Node.js 22.13 or newer and install exactly the locked dependencies with `npm ci`.
2. Create a private Supabase project. In its SQL editor, apply every file under `supabase/migrations` once, in filename order. The files are append-only, uniquely versioned schema history; do not combine, reorder, or edit an already-applied migration.
3. Run `npm run migrations:validate`. This verifies local migration order and the required pgvector, security, lifecycle, retrieval, and embedding invariants.
4. In the Supabase SQL editor, run `supabase/verify_knowledge_schema.sql` after the migrations. Every value in its single result row must be `true`. This confirms the applied database, not only the checked-in files.
5. Copy `.env.example` (or `.env.local.example`) to `.env.local` and set all three server values:
   - `GEMINI_API_KEY`: a Gemini API key allowed to call the embedding and answer models.
   - `SUPABASE_URL`: the project URL from Supabase **Project Settings → API**.
   - `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role secret from the same settings page. This is privileged and server-only.
6. Run `npm run dev`, visit `http://localhost:3000`, and open **Knowledge**.

Never commit `.env.local`, print secrets into logs or screenshots, use the service-role key in a browser component, or expose it through a `NEXT_PUBLIC_` variable. The migrations enable row-level security without browser policies; only the server-side client performs this private workflow.

### Real-service smoke test

Perform this procedure against the configured private Supabase project and Gemini API. It deliberately exercises the visible integrated states as well as the two external services.

1. Start with an empty Knowledge Base. If it contains disposable smoke data, delete that data through the interface. Reload Knowledge and confirm **Loading the Knowledge Base…** resolves to the empty state.
2. Save and upload `atlas.md` with the exact content below. Observe **indexing**, then **ready**.

   ```markdown
   # Atlas

   ## Release schedule

   Atlas production deployments happen every Friday.
   Release review begins at 14:00 UTC.
   ```

3. Save and upload `operations.txt` with the exact content below. Observe **indexing**, then **ready**.

   ```text
   The Atlas incident commander is the on-call platform engineer.

   Customer status updates are posted every thirty minutes during an incident.
   ```

4. Ask: `When does Atlas deploy and when does release review begin?` Observe **Searching…**, then a Grounded Answer. Confirm every factual paragraph has a Source Reference to `atlas.md`; select it and verify the heading path, line range, and stored excerpt are shown.
5. Ask: `What is Atlas's annual infrastructure budget?` Confirm the result is **Insufficient Evidence** and contains neither guessed answer text nor Source References.
6. Upload the unchanged `atlas.md` again (renaming it is allowed, changing its bytes is not). Confirm duplicate content is rejected and no second Project Document appears.
7. Exercise a recoverable failure using the real database without relying on an unpredictable provider outage. In the Supabase SQL editor, run the statement below, then reload Knowledge. Confirm `operations.txt` is **failed**, its detail is visible, and **Retry indexing** is offered.

   ```sql
   update public.project_documents
   set status = 'failed',
       failure_detail = 'Manual transient failure for the Week 5 smoke test.',
       failure_retryable = true,
       updated_at = now()
   where name = 'operations.txt' and status = 'ready';
   ```

8. Choose **Retry indexing**. Observe **Retrying…**/**indexing**, then **ready**. This retry removes prior chunks, calls the real Gemini embedding service again, and completes through the real Supabase lifecycle functions.
9. In Supabase, copy the `id` returned by `select id from public.project_documents where name = 'operations.txt';`. Delete `operations.txt` in the interface and confirm it disappears. Replace `<copied-id>` below and confirm this read-only query returns `0`, proving cascading chunk deletion:

   ```sql
   select count(*)
   from public.document_chunks as chunk
   where project_document_id = '<copied-id>'::uuid;
   ```

10. Switch to **Chat**, send a simple prompt, and confirm the streaming answer completes. Switch to **Spec**, generate a text-only specification, and confirm the editable structured result still appears. Return to **Knowledge** and confirm its Project Document list remains intact.

The smoke test is complete only when steps 1–10 pass. If the three external values are unavailable, report the missing credentials as the sole omitted verification; lint, controlled tests, build, and local migration validation must still pass.

### Verification from a clean checkout

Run these commands with Node.js 22.13 or newer:

```sh
npm ci
npm run migrations:validate
npm run lint
npm test
npm run build
```

The controlled suite covers upload/list/delete/retry behavior, formats and limits, duplicate and capacity enforcement, chunk/source locators, ready-only retrieval, Grounded Answers, Insufficient Evidence, invalid citations, untrusted instructions, and explicit provider/database failures. The real-service procedure above is still required because controlled boundaries cannot prove that the current Gemini and Supabase services interoperate.

## Week 3 milestone: approved tool calling

Create an editable spec in **Spec** mode, review it, and choose **Create draft task**. That explicit click is the human approval boundary. The server then gives Gemini one declared `create_task_draft` tool and forces a function call. It validates both the approved input and Gemini's tool arguments with the same Zod schema used by spec mode, rejects any model changes, and only then executes the local draft function.

The resulting draft receipt is stored with the conversation in browser local storage. It is intentionally not published or sent to an external task system. This keeps the first tool-calling milestone small while demonstrating the important loop: declare a tool, let the model request it, validate arguments, execute application code, and expose a clear approval boundary.

Created drafts also appear in the sidebar's **Draft tasks** section:

- **Open** returns to the originating conversation and focuses the approved spec.
- **Copy** places a Markdown version of the task, including priority, acceptance criteria, and implementation notes, on the clipboard.
- **Delete** removes the local draft receipt after confirmation while preserving the editable task spec, so it can be revised and approved again.

The learning-progress menu now marks **Week 3 · Tool calling** as the current milestone and keeps Weeks 1 and 2 visible as completed context.

### Acceptance criteria

- A valid editable task spec shows a **Create draft task** action.
- No tool is called until the user explicitly selects that action.
- Gemini can request only the `create_task_draft` tool for this workflow.
- The server rejects invalid arguments or any change to the approved spec.
- A successful call returns a draft ID and persists the receipt in the current browser conversation.
- Created drafts are discoverable from the Draft tasks sidebar section.
- A draft can be opened, copied as Markdown, or deleted without deleting its source specification.
- Existing streaming chat and spec generation continue to work unchanged.

### Prerequisite

Use the existing `GEMINI_API_KEY`. No database, authentication provider, or additional package is needed for this local draft milestone. Authentication and a persistent task store are required before replacing the local draft function with a real write to an external system.

## Week 4 milestone: screenshot-to-spec intake

Attach a PNG, JPEG, or WebP product screenshot from the composer, or paste a copied image while the message field is focused. The app automatically switches to **Spec** mode, renders a thumbnail inside the composer, shows the selected-file and processing states, and accepts optional context. `POST /api/task-spec` validates the upload, sends the image and context to Gemini as a multimodal request, and validates the structured result with the same Zod schema used for text requests.

The screenshot is kept only in memory for the request and its submitted-message preview. It is not written to browser storage or a server-side file store. During the current browser session, the user message shows the screenshot above its optional context. After a refresh, conversation history falls back to the filename while preserving the context and resulting editable spec. Draft creation remains a separate, explicit approval step.

### Acceptance criteria

- The composer accepts one PNG, JPEG, or WebP screenshot up to 5 MB.
- Selecting or pasting a screenshot shows its thumbnail, filename, size, ready state, and a remove action inside the composer.
- Submitting a screenshot shows a larger preview in the user message for the current browser session and a filename fallback after refresh.
- Unsupported, mislabeled, or oversized files are rejected at the API boundary; type and size are also checked in the browser for immediate feedback.
- Optional context and the screenshot are sent to Gemini in one multimodal request.
- The generated result must pass the existing task-spec Zod schema before it is rendered.
- The interface distinguishes ready, analyzing, success, and error states.
- Screenshots are not persisted in browser history or on the server.
- The returned spec stays editable and requires the existing approval action before draft creation.
- Text-only specs, streaming chat, and Week 3 draft management continue to work.

### Prerequisite

Use the existing `GEMINI_API_KEY`. Inline image data keeps this milestone stateless and avoids adding storage or another dependency. A persistent file service is only needed later if screenshots must be reused, shared across devices, or retained for audit history.
