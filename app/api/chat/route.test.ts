import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../../../lib/image-upload";

const generation = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/public-generation", () => ({
  requestPublicGeneration: generation,
  generationUnavailableResponse: () => new Response("Unavailable", { status: 503 })
}));

import { POST } from "./route";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upload(messages: unknown, image: File = new File([png], "screen.png", { type: "image/png" })) {
  const body = new FormData();
  body.set("messages", JSON.stringify(messages));
  body.set("image-1", image);
  return new Request("http://localhost/api/chat", { method: "POST", body });
}

describe("Chat image messages", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generation.mockReset().mockImplementation(async () => ({
      providerResponse: new Response('data: {"candidates":[{"content":{"parts":[{"text":"A screenshot."}]}}]}\n')
    }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("streams a conversational response to an image-only message", async () => {
    const response = await POST(upload([{ role: "user", content: "", image: "image-1" }]));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("A screenshot.");
    expect(generation.mock.calls[0][3].contents).toEqual([{
      role: "user",
      parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from(png).toString("base64") } }]
    }]);
  });

  it("keeps the image, question, and conversation history together on follow-up", async () => {
    const response = await POST(upload([
      { role: "user", content: "Explain this", image: "image-1" },
      { role: "assistant", content: "A screenshot." },
      { role: "user", content: "What color is the button?" }
    ]));
    expect(response.status).toBe(200);
    expect(generation.mock.calls[0][3].contents).toEqual([
      { role: "user", parts: [{ text: "Explain this" }, { inlineData: { mimeType: "image/png", data: Buffer.from(png).toString("base64") } }] },
      { role: "model", parts: [{ text: "A screenshot." }] },
      { role: "user", parts: [{ text: "What color is the button?" }] }
    ]);
    await response.text();
  });

  it.each([
    [new File([png], "image.gif", { type: "image/gif" }), 415],
    [new File(["fake"], "image.png", { type: "image/png" }), 415],
    [new File([], "image.png", { type: "image/png" }), 400],
    [new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "image.png", { type: "image/png" }), 413]
  ])("rejects invalid uploads before generation", async (image, status) => {
    const response = await POST(upload([{ role: "user", content: "Explain", image: "image-1" }], image));
    expect(response.status).toBe(status);
    expect(generation).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: "user", content: "Explain", image: "missing" }],
    [{ role: "assistant", content: "Explain", image: "image-1" }]
  ])("rejects invalid image references before generation", async (message) => {
    const response = await POST(upload([message]));
    expect(response.status).toBe(400);
    expect(generation).not.toHaveBeenCalled();
  });

  it("preserves text-only JSON requests and ignores malformed history entries", async () => {
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [null, { role: "user", content: " Hello " }] })
    }));
    expect(response.status).toBe(200);
    expect(generation.mock.calls[0][3].contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
    await response.text();
  });
});
