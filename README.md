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

Attach a PNG, JPEG, or WebP product screenshot from the composer. The app automatically switches to **Spec** mode, shows the selected-file and processing states, and accepts optional context. `POST /api/task-spec` validates the upload, sends the image and context to Gemini as a multimodal request, and validates the structured result with the same Zod schema used for text requests.

The screenshot is kept only in memory for the request. It is not written to browser storage or a server-side file store. Conversation history keeps the filename, optional context, and resulting editable spec. Draft creation remains a separate, explicit approval step.

### Acceptance criteria

- The composer accepts one PNG, JPEG, or WebP screenshot up to 5 MB.
- Selecting a screenshot shows its filename, size, ready state, and a remove action.
- Unsupported, mislabeled, or oversized files are rejected at the API boundary; type and size are also checked in the browser for immediate feedback.
- Optional context and the screenshot are sent to Gemini in one multimodal request.
- The generated result must pass the existing task-spec Zod schema before it is rendered.
- The interface distinguishes ready, analyzing, success, and error states.
- Screenshots are not persisted in browser history or on the server.
- The returned spec stays editable and requires the existing approval action before draft creation.
- Text-only specs, streaming chat, and Week 3 draft management continue to work.

### Prerequisite

Use the existing `GEMINI_API_KEY`. Inline image data keeps this milestone stateless and avoids adding storage or another dependency. A persistent file service is only needed later if screenshots must be reused, shared across devices, or retained for audit history.
