import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ admissionCalls: 0 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ count: 1, error: null })
      })
    }),
    rpc: async (name: string) => {
      if (name === "admit_public_action") {
        database.admissionCalls += 1;
        return { data: { admitted: true, limited_by: null, reset_at: null }, error: null };
      }
      if (name === "match_ready_document_chunks_hybrid") {
        return {
          data: [{
            chunk_id: "chunk-1",
            document_name: "atlas.md",
            text: "Atlas deploys on Fridays.",
            heading_path: ["Atlas"],
            start_line: 2,
            end_line: 2,
            cosine_distance: 0.01,
            fts_rank: 0,
            rrf_score: 0.02
          }],
          error: null
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
  }))
}));

vi.mock("server-only", () => ({}));

const approvedSpec = {
  title: "Add status banner",
  summary: "Show the current service state.",
  priority: "medium" as const,
  acceptanceCriteria: ["The state is visible.", "The banner is accessible."],
  implementationNotes: ["Use the existing page layout."]
};

function routeRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.9"
    },
    body: JSON.stringify(body)
  });
}

function dailyQuotaResponse() {
  return Response.json({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }]
      }]
    }
  }, { status: 429 });
}

function shortWindowQuotaResponse() {
  return Response.json({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "Rate limit exceeded",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" }]
    }
  }, { status: 429 });
}

describe("compatible generation fallback at API route seams", () => {
  beforeEach(() => {
    vi.resetModules();
    database.admissionCalls = 0;
    process.env.GEMINI_API_KEY = "gemini-test-key";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.VISITOR_ID_SECRET = "visitor-id-test-secret-with-enough-entropy";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.GEMINI_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VISITOR_ID_SECRET;
  });

  it("uses the secondary model once when the primary daily generation quota is exhausted", async () => {
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("gemini-3.5-flash-lite")) return dailyQuotaResponse();
      if (url.includes("gemini-3.1-flash-lite")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(approvedSpec) }] } }] });
      }
      throw new Error(`Unexpected provider URL ${url}`);
    });
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./task-spec/route");

    const response = await POST(routeRequest("/api/task-spec", { request: "Add a status banner" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ taskSpec: approvedSpec });
    expect(provider.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("gemini-3.5-flash-lite:generateContent"),
      expect.stringContaining("gemini-3.1-flash-lite:generateContent")
    ]);
    expect(database.admissionCalls).toBe(1);
  });

  it("uses the compatible secondary model across Chat, task drafts, and Grounded Answers", async () => {
    const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(":embedContent")) {
        return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
      }
      if (url.includes("gemini-3.5-flash-lite")) return dailyQuotaResponse();
      if (url.includes("streamGenerateContent")) {
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n');
      }

      const body = JSON.parse(String(init?.body)) as { tools?: unknown; systemInstruction?: unknown };
      if (body.tools) {
        return Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "create_task_draft", args: approvedSpec } }] } }] });
      }
      if (body.systemInstruction) {
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          outcome: "answered",
          paragraphs: [{ text: "Atlas deploys on Fridays.", chunkIds: ["source-1"] }]
        }) }] } }] });
      }
      throw new Error(`Unexpected request body for ${url}`);
    });
    vi.stubGlobal("fetch", provider);
    const chat = await import("./chat/route");
    const taskDraft = await import("./task-draft/route");
    const questions = await import("./knowledge/questions/route");

    const chatResponse = await chat.POST(routeRequest("/api/chat", { messages: [{ role: "user", content: "Hello" }] }));
    const draftResponse = await taskDraft.POST(routeRequest("/api/task-draft", { taskSpec: approvedSpec }));
    const answerResponse = await questions.POST(routeRequest("/api/knowledge/questions", { question: "When does Atlas deploy?" }));

    await expect(chatResponse.text()).resolves.toBe("Hello");
    expect(draftResponse.status).toBe(200);
    await expect(answerResponse.json()).resolves.toMatchObject({ outcome: "answered" });
    const generationUrls = provider.mock.calls.map(([input]) => String(input)).filter((url) => !url.includes(":embedContent"));
    expect(generationUrls.filter((url) => url.includes("gemini-3.5-flash-lite"))).toHaveLength(3);
    expect(generationUrls.filter((url) => url.includes("gemini-3.1-flash-lite"))).toHaveLength(3);
    expect(database.admissionCalls).toBe(3);
  });

  it("retries a short-window rate limit on the primary model with bounded jitter and does not fall back", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      queueMicrotask(() => typeof handler === "function" && handler());
      return 1;
    }) as typeof setTimeout);
    const provider = vi.fn()
      .mockResolvedValueOnce(shortWindowQuotaResponse())
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(approvedSpec) }] } }] }));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./task-spec/route");

    const response = await POST(routeRequest("/api/task-spec", { request: "Add a status banner" }));

    expect(response.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([150]);
    expect(provider.mock.calls.every(([input]) => String(input).includes("gemini-3.5-flash-lite"))).toBe(true);
    expect(database.admissionCalls).toBe(1);
  });

  it("returns a stable unavailable outcome without provider details when both models exhaust daily quota", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(dailyQuotaResponse));
    const { POST } = await import("./task-spec/route");

    const response = await POST(routeRequest("/api/task-spec", { request: "Add a status banner" }));
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(503);
    expect(payload).toEqual({ error: "Generation is temporarily unavailable. Please try again later." });
    expect(JSON.stringify(payload)).not.toContain("RESOURCE_EXHAUSTED");
    expect(database.admissionCalls).toBe(1);
  });

  it("returns stable unavailable Chat behavior instead of an upstream body or status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider secret: invalid project", { status: 418 })));
    const { POST } = await import("./chat/route");

    const response = await POST(routeRequest("/api/chat", { messages: [{ role: "user", content: "Hello" }] }));

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Generation is temporarily unavailable. Please try again later.");
  });

  it("does not leak a non-daily secondary failure after primary daily exhaustion", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(dailyQuotaResponse())
      .mockResolvedValueOnce(new Response("secondary provider account detail", { status: 403 }));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./chat/route");

    const response = await POST(routeRequest("/api/chat", { messages: [{ role: "user", content: "Hello" }] }));

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Generation is temporarily unavailable. Please try again later.");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("applies the existing Spec schema to invalid secondary output", async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(dailyQuotaResponse())
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: '{"title":"incomplete"}' }] } }] }));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./task-spec/route");

    const response = await POST(routeRequest("/api/task-spec", { request: "Add a status banner" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Gemini returned an invalid task specification. Please try again." });
    expect(database.admissionCalls).toBe(1);
  });

  it("applies the exact approved-Spec check to secondary task tool calls", async () => {
    const changedSpec = { ...approvedSpec, summary: "Changed by the model." };
    const provider = vi.fn()
      .mockResolvedValueOnce(dailyQuotaResponse())
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{
        functionCall: { name: "create_task_draft", args: changedSpec }
      }] } }] }));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./task-draft/route");

    const response = await POST(routeRequest("/api/task-draft", { taskSpec: approvedSpec }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Gemini changed the approved task spec, so no draft was created." });
    expect(database.admissionCalls).toBe(1);
  });

  it("applies existing Source Reference validation to secondary Grounded Answers", async () => {
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":embedContent")) {
        return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
      }
      if (url.includes("gemini-3.5-flash-lite")) return dailyQuotaResponse();
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        outcome: "answered",
        paragraphs: [{ text: "Unsupported.", chunkIds: ["source-999"] }]
      }) }] } }] });
    });
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./knowledge/questions/route");

    const response = await POST(routeRequest("/api/knowledge/questions", { question: "When does Atlas deploy?" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_model_output",
      error: "Gemini cited a passage that was not retrieved."
    });
    expect(database.admissionCalls).toBe(1);
  });

  it("does not fall back for authentication failures", async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({
      error: { status: "UNAUTHENTICATED", message: "bad key" }
    }, { status: 401 }));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./task-spec/route");

    const response = await POST(routeRequest("/api/task-spec", { request: "Add a status banner" }));

    expect(response.status).toBe(502);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(String(provider.mock.calls[0][0])).toContain("gemini-3.5-flash-lite");
  });

  it("does not restart a Chat stream after content has been emitted", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const provider = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n'));
          return;
        }
        controller.error(new Error("stream interrupted"));
      }
    })));
    vi.stubGlobal("fetch", provider);
    const { POST } = await import("./chat/route");

    const response = await POST(routeRequest("/api/chat", { messages: [{ role: "user", content: "Hello" }] }));
    await expect(response.text()).rejects.toThrow("stream interrupted");

    expect(provider).toHaveBeenCalledTimes(1);
    expect(String(provider.mock.calls[0][0])).toContain("gemini-3.5-flash-lite");
    expect(database.admissionCalls).toBe(1);
  });
});
