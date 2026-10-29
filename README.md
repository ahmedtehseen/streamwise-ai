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
