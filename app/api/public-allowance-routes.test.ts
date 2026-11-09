import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  admissionResults: [] as Array<{ data: unknown; error: { message: string } | null }>,
  admissionCalls: [] as Array<Record<string, unknown>>,
  readyDocumentCount: 1
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ count: database.readyDocumentCount, error: null })
      })
    }),
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      if (name === "admit_public_action") {
        database.admissionCalls.push(parameters);
        return database.admissionResults.shift() ?? {
          data: { admitted: true, limited_by: null, reset_at: null },
          error: null
        };
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

function request(path: string, body: unknown, withIdentity = true) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (withIdentity) headers.set("x-vercel-forwarded-for", "203.0.113.9");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

function stubGemini() {
  const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("streamGenerateContent")) {
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n');
    }
    if (url.includes(":embedContent")) {
      return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
    }
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; systemInstruction?: unknown };
      if (body.systemInstruction) {
        return Response.json({ candidates: [{ content: { parts: [{
          text: JSON.stringify({
            outcome: "answered",
            paragraphs: [{ text: "Atlas deploys on Fridays.", chunkIds: ["source-1"] }]
          })
        }] } }] });
      }
      return Response.json({ candidates: [{ content: { parts: [{
        text: JSON.stringify(approvedSpec),
        ...(body.tools ? { functionCall: { name: "create_task_draft", args: approvedSpec } } : {})
      }] } }] });
    }
    throw new Error(`Unexpected provider URL ${url}`);
  });
  vi.stubGlobal("fetch", provider);
  return provider;
}

describe("shared public allowance at API route seams", () => {
  beforeEach(() => {
    vi.resetModules();
    database.admissionResults = [];
    database.admissionCalls = [];
    database.readyDocumentCount = 1;
    process.env.GEMINI_API_KEY = "gemini-test-key";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.VISITOR_ID_SECRET = "visitor-id-test-secret-with-enough-entropy";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.GEMINI_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VISITOR_ID_SECRET;
  });

  it("admits Chat, Spec generation, task-draft creation, and Portfolio Assistant questions through one shared operation", async () => {
    stubGemini();
    const chat = await import("./chat/route");
    const taskSpec = await import("./task-spec/route");
    const taskDraft = await import("./task-draft/route");
    const questions = await import("./knowledge/questions/route");

    const responses = await Promise.all([
      chat.POST(request("/api/chat", { messages: [{ role: "user", content: "Hello" }] })),
      taskSpec.POST(request("/api/task-spec", { request: "Add a status banner" })),
      taskDraft.POST(request("/api/task-draft", { taskSpec: approvedSpec })),
      questions.POST(request("/api/knowledge/questions", { question: "When does Atlas deploy?" }))
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(database.admissionCalls).toHaveLength(4);
    expect(new Set(database.admissionCalls.map((call) => call.p_visitor_id)).size).toBe(1);
    expect(database.admissionCalls.every((call) => typeof call.p_visitor_id === "string" && call.p_visitor_id !== "203.0.113.9")).toBe(true);
  });

  it("rejects malformed input before admission on every public route", async () => {
    const provider = stubGemini();
    const chat = await import("./chat/route");
    const taskSpec = await import("./task-spec/route");
    const taskDraft = await import("./task-draft/route");
    const questions = await import("./knowledge/questions/route");

    const responses = await Promise.all([
      chat.POST(request("/api/chat", { messages: [] })),
      taskSpec.POST(request("/api/task-spec", { request: "" })),
      taskDraft.POST(request("/api/task-draft", { taskSpec: null })),
      questions.POST(request("/api/knowledge/questions", { question: "" }))
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(database.admissionCalls).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects malformed Chat JSON without consuming allowance", async () => {
    const provider = stubGemini();
    const { POST } = await import("./chat/route");

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vercel-forwarded-for": "203.0.113.9"
      },
      body: "{not-json"
    }));

    expect(response.status).toBe(400);
    expect(database.admissionCalls).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed before Gemini when trusted Visitor identity is missing", async () => {
    const provider = stubGemini();
    const { POST } = await import("./task-spec/route");

    const response = await POST(request("/api/task-spec", { request: "Add a status banner" }, false));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "visitor_identity_unavailable",
      retryable: true
    });
    expect(database.admissionCalls).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed before Gemini when durable allowance storage is unavailable", async () => {
    database.admissionResults.push({ data: null, error: { message: "database unavailable" } });
    const provider = stubGemini();
    const { POST } = await import("./task-spec/route");

    const response = await POST(request("/api/task-spec", { request: "Add a status banner" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "allowance_unavailable",
      retryable: true
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rotates the one-way Visitor identifier at Pacific midnight without sending the raw address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stubGemini();
    const { POST } = await import("./task-spec/route");
    vi.setSystemTime(new Date("2026-11-07T07:59:59.000Z"));
    await POST(request("/api/task-spec", { request: "Add a status banner" }));
    vi.setSystemTime(new Date("2026-11-07T08:00:00.000Z"));
    await POST(request("/api/task-spec", { request: "Add a status banner" }));

    const visitorIds = database.admissionCalls.map((call) => call.p_visitor_id);
    expect(visitorIds).toHaveLength(2);
    expect(visitorIds[0]).not.toBe(visitorIds[1]);
    expect(visitorIds.every((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(JSON.stringify(database.admissionCalls)).not.toContain("203.0.113.9");
  });

  it.each([
    ["visitor_minute", "2026-11-06T12:35:00.000Z", "minute"],
    ["global_day", "2026-11-07T08:00:00.000Z", "daily"]
  ])("returns a clear 429 for a %s limit with its reset time", async (limitedBy, resetAt, windowLabel) => {
    database.admissionResults.push({ data: { admitted: false, limited_by: limitedBy, reset_at: resetAt }, error: null });
    const provider = stubGemini();
    const { POST } = await import("./task-spec/route");

    const response = await POST(request("/api/task-spec", { request: "Add a status banner" }));
    const payload = await response.json() as { error: string; code: string; resetAt: string };

    expect(response.status).toBe(429);
    expect(payload).toMatchObject({ code: "public_allowance_limited", resetAt });
    expect(payload.error).toContain(windowLabel);
    expect(provider).not.toHaveBeenCalled();
  });
});
