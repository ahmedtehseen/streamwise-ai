import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenerationCancelledError,
  GenerationTimeoutError,
  providerErrorSummary,
  requestGeneration
} from "./generation";

function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
}

describe("requestGeneration deadlines and cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws GenerationTimeoutError when the provider does not answer before the deadline", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(requestGeneration("generateContent", "key", {}, { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(GenerationTimeoutError);
  });

  it("throws GenerationCancelledError and aborts the provider call when the caller cancels", async () => {
    const provider = hangingFetch();
    vi.stubGlobal("fetch", provider);
    const caller = new AbortController();
    const pending = requestGeneration("generateContent", "key", {}, { signal: caller.signal, timeoutMs: 5_000 });
    caller.abort();
    await expect(pending).rejects.toBeInstanceOf(GenerationCancelledError);
    expect((provider.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("stops waiting for the short-window retry when the deadline passes", async () => {
    const provider = vi.fn().mockResolvedValue(Response.json(
      { error: { status: "RESOURCE_EXHAUSTED", details: [{ quotaId: "PerMinute" }] } },
      { status: 429 }
    ));
    vi.stubGlobal("fetch", provider);
    await expect(requestGeneration("generateContent", "key", {}, { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(GenerationTimeoutError);
  });

  it("passes through ordinary provider responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
    const response = await requestGeneration("generateContent", "key", {});
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("providerErrorSummary", () => {
  it("keeps the HTTP and provider status codes but never the provider message", async () => {
    const response = Response.json(
      { error: { status: "INVALID_ARGUMENT", message: "Prompt contained: secret project text" } },
      { status: 400 }
    );
    const summary = await providerErrorSummary(response);
    expect(summary).toEqual({ httpStatus: 400, providerStatus: "INVALID_ARGUMENT" });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("drops non-JSON bodies entirely", async () => {
    await expect(providerErrorSummary(new Response("raw upstream text", { status: 502 })))
      .resolves.toEqual({ httpStatus: 502 });
  });
});
