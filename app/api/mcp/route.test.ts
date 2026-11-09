import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  admissionCalls: 0,
  rpcNames: [] as string[],
  admissionResult: { data: { admitted: true, limited_by: null, reset_at: null }, error: null } as {
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  },
  readyDocumentCount: 1,
  countError: null as { message: string } | null,
  retrievalError: null as { message: string; code?: string } | null,
  chunks: [] as Array<Record<string, unknown>>
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ count: database.readyDocumentCount, error: database.countError })
      })
    }),
    rpc: async (name: string) => {
      database.rpcNames.push(name);
      if (name === "admit_public_action") {
        database.admissionCalls += 1;
        return database.admissionResult;
      }
      return { data: database.chunks, error: database.retrievalError };
    }
  }))
}));

vi.mock("server-only", () => ({}));

describe("public Portfolio Assistant MCP endpoint", () => {
  beforeEach(() => {
    database.admissionCalls = 0;
    database.rpcNames = [];
    database.admissionResult = { data: { admitted: true, limited_by: null, reset_at: null }, error: null };
    database.readyDocumentCount = 1;
    database.countError = null;
    database.retrievalError = null;
    database.chunks = [];
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    process.env.VISITOR_ID_SECRET = "visitor-id-test-secret-with-enough-entropy";
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VISITOR_ID_SECRET;
  });

  async function connect(withIdentity = true) {
    const route = await import("./route");
    const client = new Client({ name: "streamwise-test-client", version: "1.0.0" });
    const headers = new Headers();
    if (withIdentity) headers.set("x-vercel-forwarded-for", "203.0.113.9");
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      requestInit: { headers },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST") return route.POST(request);
        if (request.method === "GET") return route.GET(request);
        return route.DELETE(request);
      }
    });
    await client.connect(transport);
    return client;
  }

  it("initializes through Streamable HTTP and discovers only the bounded read-only tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools).toEqual([expect.objectContaining({
      name: "ask_portfolio",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false
      },
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["question"]
      })
    })]);
    expect(tools[0].inputSchema.properties).toEqual({
      question: expect.objectContaining({ type: "string", minLength: 1, maxLength: 500 })
    });
  });

  it("returns a Grounded Answer with Source References and consumes one existing public action", async () => {
    database.chunks = [{
      chunk_id: "chunk-atlas",
      document_name: "atlas.md",
      text: "Atlas deployments happen on Fridays.",
      heading_path: ["Atlas", "Launch"],
      start_line: 7,
      end_line: 7,
      cosine_distance: 0.04
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(":embedContent")) {
        return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
      }
      return Response.json({ candidates: [{ content: { parts: [{
        text: JSON.stringify({
          outcome: "answered",
          paragraphs: [{ text: "Atlas deploys on Fridays.", chunkIds: ["source-1"] }]
        })
      }] } }] });
    }));

    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      outcome: "answered",
      responseId: expect.any(String),
      respondedAt: expect.any(String),
      paragraphs: [{
        text: "Atlas deploys on Fridays.",
        sourceReferences: [{
          id: "source-1",
          documentName: "atlas.md",
          headingPath: ["Atlas", "Launch"],
          startLine: 7,
          endLine: 7,
          excerpt: "Atlas deployments happen on Fridays."
        }]
      }]
    });
    expect(database.admissionCalls).toBe(1);
  });

  it.each([
    ["blank", { question: "   " }],
    ["too long", { question: "q".repeat(501) }],
    ["with an unknown field", { question: "When does Atlas deploy?", owner: true }]
  ])("rejects %s input without consuming public allowance", async (_label, arguments_) => {
    const client = await connect();
    const result = await client.callTool({ name: "ask_portfolio", arguments: arguments_ });
    await client.close();

    expect(result.isError).toBe(true);
    expect(database.admissionCalls).toBe(0);
  });

  it("consumes exactly one public action for a valid question when the Knowledge Base is empty", async () => {
    database.readyDocumentCount = 0;
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      outcome: "error",
      error: {
        code: "knowledge_base_empty",
        message: "The Knowledge Base has no ready Project Documents.",
        retryable: false
      }
    });
    expect(database.admissionCalls).toBe(1);
  });

  it("returns Insufficient Evidence as a successful machine-distinguishable outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } })
    )));
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "What is the Atlas budget?" }
    });
    await client.close();

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      outcome: "insufficient_evidence",
      paragraphs: []
    });
    expect(database.admissionCalls).toBe(1);
  });

  it("preserves a degraded-search Grounded Answer without duplicating retrieval", async () => {
    database.chunks = [{
      chunk_id: "chunk-atlas",
      document_name: "atlas.md",
      text: "Atlas deployments happen on Fridays.",
      heading_path: [],
      start_line: 7,
      end_line: 7,
      cosine_distance: 1,
      fts_rank: 0.8
    }];
    const provider = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(":embedContent")) {
        return Response.json({ error: { message: "provider details must stay private" } }, { status: 503 });
      }
      return Response.json({ candidates: [{ content: { parts: [{
        text: JSON.stringify({
          outcome: "answered",
          paragraphs: [{ text: "Atlas deploys on Fridays.", chunkIds: ["source-1"] }]
        })
      }] } }] });
    });
    vi.stubGlobal("fetch", provider);

    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toMatchObject({
      ok: true,
      outcome: "answered",
      degradedSearch: true
    });
    expect(database.rpcNames).toEqual([
      "admit_public_action",
      "match_ready_document_chunks_full_text"
    ]);
    expect(provider.mock.calls.every(([url]) => !String(url).includes("localhost"))).toBe(true);
  });

  it("fails closed with a sanitized code when trusted Visitor identity is unavailable", async () => {
    const client = await connect(false);
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toEqual({
      ok: false,
      outcome: "error",
      error: {
        code: "visitor_identity_unavailable",
        message: "Streamwise could not verify the Visitor identity required for public access.",
        retryable: true
      }
    });
    expect(database.admissionCalls).toBe(0);
  });

  it("preserves shared limit and reset information in a sanitized MCP error", async () => {
    database.admissionResult = {
      data: {
        admitted: false,
        limited_by: "global_day",
        reset_at: "2026-11-11T08:00:00.000Z"
      },
      error: null
    };
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toMatchObject({
      ok: false,
      outcome: "error",
      error: {
        code: "public_allowance_limited",
        retryable: true,
        limitedBy: "global_day",
        resetAt: "2026-11-11T08:00:00.000Z"
      }
    });
    expect(database.admissionCalls).toBe(1);
  });

  it("sanitizes database failures after consuming exactly one public action", async () => {
    database.countError = { message: "password=secret internal database host" };
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toEqual({
      ok: false,
      outcome: "error",
      error: {
        code: "database_unavailable",
        message: "The Knowledge Base is temporarily unavailable.",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("password=secret");
    expect(database.admissionCalls).toBe(1);
  });

  it("fails closed with a sanitized code when allowance storage is unavailable", async () => {
    database.admissionResult = {
      data: null,
      error: { message: "internal allowance database details" }
    };
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toEqual({
      ok: false,
      outcome: "error",
      error: {
        code: "allowance_unavailable",
        message: "Public usage allowance is temporarily unavailable. Please try again later.",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("internal allowance database details");
    expect(database.admissionCalls).toBe(1);
  });

  it("sanitizes provider failures without changing their stable failure code", async () => {
    database.chunks = [{
      chunk_id: "chunk-atlas",
      document_name: "atlas.md",
      text: "Atlas deployments happen on Fridays.",
      heading_path: [],
      start_line: 7,
      end_line: 7,
      cosine_distance: 0.04
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(":embedContent")) {
        return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
      }
      return Response.json({ error: { message: "provider account 123 secret payload" } }, { status: 503 });
    }));
    const client = await connect();
    const result = await client.callTool({
      name: "ask_portfolio",
      arguments: { question: "When does Atlas deploy?" }
    });
    await client.close();

    expect(result.structuredContent).toEqual({
      ok: false,
      outcome: "error",
      error: {
        code: "gemini_unavailable",
        message: "The Portfolio Assistant is temporarily unavailable.",
        retryable: true
      }
    });
    expect(JSON.stringify(result)).not.toContain("account 123");
    expect(database.admissionCalls).toBe(1);
  });
});
