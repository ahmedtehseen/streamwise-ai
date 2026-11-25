import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_MESSAGE_CHARS,
  MAX_CHAT_REQUEST_BYTES,
  MAX_CHAT_TOTAL_CHARS,
  parseChatStream,
  STREAM_ERROR_MARKER
} from "../../../lib/chat-stream";

const generation = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/public-generation", () => ({
  requestPublicGeneration: generation,
  generationUnavailableResponse: () => new Response("Unavailable", { status: 503 })
}));

import { POST } from "./route";

function sse(...events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
}

function chat(messages: unknown, init: RequestInit = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify({ messages }),
    signal: init.signal
  });
}

function provide(body: string | ReadableStream<Uint8Array>) {
  generation.mockResolvedValue({ providerResponse: new Response(body) });
}

const hello = [{ role: "user", content: "Hello" }];

describe("Chat stream terminal semantics", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generation.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("closes cleanly when the model reports STOP", async () => {
    provide(sse(
      { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }] }
    ));
    const text = await (await POST(chat(hello))).text();
    expect(parseChatStream(text)).toEqual({ text: "Hello" });
  });

  it.each([
    ["no finish reason", sse({ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }), "The model stream ended before the answer finished."],
    ["a SAFETY stop", sse({ candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "SAFETY" }] }), "The model stopped before finishing the answer."],
    ["an in-stream provider error", sse({ candidates: [{ content: { parts: [{ text: "Partial" }] } }] }, { error: { code: 500 } }), "The model stream reported an error."]
  ])("reports %s as an interrupted answer and keeps the partial text", async (_name, body, reason) => {
    provide(body);
    const text = await (await POST(chat(hello))).text();
    expect(parseChatStream(text)).toEqual({ text: "Partial", error: reason });
  });

  it("reports an empty answer as an error", async () => {
    provide(sse({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    const text = await (await POST(chat(hello))).text();
    expect(parseChatStream(text)).toEqual({ text: "", error: "The model returned an empty answer." });
  });

  it("reports a deadline hit mid-stream as a timeout", async () => {
    const encoder = new TextEncoder();
    let sent = false;
    provide(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(sse({ candidates: [{ content: { parts: [{ text: "Partial" }] } }] })));
          return;
        }
        controller.error(new DOMException("The operation timed out.", "TimeoutError"));
      }
    }));
    const text = await (await POST(chat(hello))).text();
    expect(parseChatStream(text)).toEqual({ text: "Partial", error: "The answer took too long and was stopped." });
  });

  it("strips the marker character from model text so it cannot forge an error record", async () => {
    provide(sse({ candidates: [{ content: { parts: [{ text: `a${STREAM_ERROR_MARKER}{"error":"x"}` }] }, finishReason: "STOP" }] }));
    const text = await (await POST(chat(hello))).text();
    expect(parseChatStream(text)).toEqual({ text: 'a{"error":"x"}' });
  });

  it("cancels the upstream provider stream when the client cancels the response", async () => {
    let upstreamCancelled = false;
    provide(new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: () => { upstreamCancelled = true; }
    }));
    const response = await POST(chat(hello));
    await response.body?.cancel();
    expect(upstreamCancelled).toBe(true);
  });
});

describe("Chat request bounds", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generation.mockReset();
    provide(sse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects a declared body larger than the request cap before reading it", async () => {
    const response = await POST(chat(hello, { headers: { "content-length": String(MAX_CHAT_REQUEST_BYTES + 1) } }));
    expect(response.status).toBe(413);
    expect(generation).not.toHaveBeenCalled();
  });

  it("rejects a new message over the per-message limit", async () => {
    const response = await POST(chat([{ role: "user", content: "x".repeat(MAX_CHAT_MESSAGE_CHARS + 1) }]));
    expect(response.status).toBe(413);
    expect(generation).not.toHaveBeenCalled();
  });

  it("drops the oldest history that exceeds the total text budget instead of failing", async () => {
    const long = "y".repeat(MAX_CHAT_TOTAL_CHARS / 2);
    const response = await POST(chat([
      { role: "user", content: "oldest" },
      { role: "assistant", content: long },
      { role: "user", content: long },
      { role: "assistant", content: "short" },
      { role: "user", content: "latest" }
    ]));
    expect(response.status).toBe(200);
    const contents = generation.mock.calls[0][3].contents as Array<{ parts: Array<{ text?: string }> }>;
    expect(contents.map((content) => content.parts[0].text?.slice(0, 6))).toEqual(["yyyyyy", "short", "latest"]);
    await response.text();
  });
});

describe("parseChatStream", () => {
  it("treats a partially received error record as an interruption", () => {
    expect(parseChatStream(`Hi${STREAM_ERROR_MARKER}{"err`)).toEqual({ text: "Hi", error: "The response was interrupted." });
  });
});
