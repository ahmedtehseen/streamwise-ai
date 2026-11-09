import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type StoredFlag = {
  id: string;
  response_id: string;
  question: string;
  outcome: "answered" | "insufficient_evidence";
  response_content: { paragraphs: Array<Record<string, unknown>>; degradedSearch: boolean };
  source_references: Array<Record<string, unknown>>;
  responded_at: string;
  visitor_note: string | null;
  status: "open" | "reviewed";
  reviewed_at: string | null;
  created_at: string;
};

const database = vi.hoisted(() => ({
  calls: 0,
  error: null as { message: string } | null,
  flags: [] as StoredFlag[]
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    database.calls += 1;
    return {
      from: () => ({
        select: () => ({
          eq: (column: string, value: string) => {
            if (column === "id") {
              return {
                maybeSingle: async () => ({
                  data: database.flags.find((flag) => flag.id === value) ?? null,
                  error: database.error
                })
              };
            }
            const filtered = () => database.flags
              .filter((flag) => flag.status === value)
              .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
            return {
              order: () => ({
                order: () => ({
                  limit: async (limit: number) => ({ data: filtered().slice(0, limit), error: database.error }),
                  or: (expression: string) => ({
                    limit: async (limit: number) => {
                      const createdAt = expression.match(/created_at\.lt\.([^,]+)/)?.[1] ?? "";
                      const id = expression.match(/id\.lt\.([^\)]+)/)?.[1] ?? "";
                      return {
                        data: filtered()
                          .filter((flag) => flag.created_at < createdAt || (flag.created_at === createdAt && flag.id < id))
                          .slice(0, limit),
                        error: database.error
                      };
                    }
                  })
                })
              })
            };
          }
        })
      })
    };
  })
}));

vi.mock("server-only", () => ({}));

const ownerToken = "owner-token-with-at-least-thirty-two-characters";
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional()
}).passthrough();

function toolText(result: unknown) {
  const parsed = toolResultSchema.parse(result);
  const firstContent = parsed.content[0];
  if (firstContent?.type !== "text" || firstContent.text === undefined) {
    throw new Error("Expected one text MCP tool result.");
  }
  return firstContent.text;
}
const firstFlag: StoredFlag = {
  id: "11111111-1111-4111-8111-111111111111",
  response_id: "issued-response-1",
  question: "When does Atlas deploy?",
  outcome: "answered",
  response_content: {
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
    }],
    degradedSearch: false
  },
  source_references: [{
    id: "source-1",
    documentName: "atlas.md",
    headingPath: ["Atlas", "Launch"],
    startLine: 7,
    endLine: 7,
    excerpt: "Atlas deployments happen on Fridays."
  }],
  responded_at: "2026-11-06T08:00:00.000Z",
  visitor_note: "Check the deployment day.",
  status: "open",
  reviewed_at: null,
  created_at: "2026-11-06T08:05:00.000Z"
};

async function routeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const route = await import("./route");
  if (request.method === "GET") return route.GET(request);
  if (request.method === "DELETE") return route.DELETE(request);
  return route.POST(request);
}

async function ownerClient(token = ownerToken) {
  const client = new Client({ name: "streamwise-owner-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp/owner"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: routeFetch
  });
  await client.connect(transport);
  return { client, transport };
}

describe("owner MCP endpoint", () => {
  beforeEach(() => {
    database.calls = 0;
    database.error = null;
    database.flags = [
      firstFlag,
      {
        ...firstFlag,
        id: "00000000-0000-4000-8000-000000000002",
        question: "What is Atlas?",
        created_at: "2026-11-06T08:04:00.000Z"
      },
      {
        ...firstFlag,
        id: "22222222-2222-4222-8222-222222222222",
        status: "reviewed",
        reviewed_at: "2026-11-06T09:00:00.000Z",
        created_at: "2026-11-06T08:03:00.000Z"
      }
    ];
    process.env.MCP_OWNER_TOKEN = ownerToken;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  });

  afterEach(() => {
    delete process.env.MCP_OWNER_TOKEN;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_SECRET;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    ["missing credential", undefined],
    ["malformed credential", "Token not-a-bearer-token"],
    ["incorrect credential", "Bearer incorrect-owner-token-with-enough-length"]
  ])("rejects initialization with a %s before MCP discovery", async (_label, authorization) => {
    const response = await routeFetch("http://localhost/api/mcp/owner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "unauthorized-test", version: "1.0.0" }
        }
      })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
    expect(database.calls).toBe(0);
  });

  it.each([
    ["discovery", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
    ["invocation", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_answer_flag", arguments: { flagId: firstFlag.id } }
    }]
  ])("rejects unauthorized %s before storage", async (_label, body) => {
    const response = await routeFetch("http://localhost/api/mcp/owner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(401);
    expect(database.calls).toBe(0);
  });

  it("fails closed when MCP_OWNER_TOKEN is not configured", async () => {
    delete process.env.MCP_OWNER_TOKEN;

    const response = await routeFetch("http://localhost/api/mcp/owner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "unconfigured-test", version: "1.0.0" }
        }
      })
    });

    expect(response.status).toBe(401);
    expect(database.calls).toBe(0);
  });

  it("fails closed when MCP_OWNER_TOKEN reuses ADMIN_SECRET", async () => {
    process.env.ADMIN_SECRET = ownerToken;

    const response = await routeFetch("http://localhost/api/mcp/owner", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "shared-secret-test", version: "1.0.0" }
        }
      })
    });

    expect(response.status).toBe(401);
    expect(database.calls).toBe(0);
  });

  it("initializes with a real MCP client and discovers only owner read tools", async () => {
    const { client, transport } = await ownerClient();

    const discovery = await client.listTools();

    expect(discovery.tools.map((tool) => tool.name)).toEqual([
      "list_answer_flags",
      "get_answer_flag"
    ]);
    expect(discovery.tools.map((tool) => tool.annotations)).toEqual([
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
    ]);
    expect(database.calls).toBe(0);
    await transport.close();
  });

  it("lists filtered Answer Flag summaries in bounded cursor pages", async () => {
    const { client, transport } = await ownerClient();

    const first = await client.callTool({ name: "list_answer_flags", arguments: { limit: 1 } });
    const firstPage = JSON.parse(toolText(first));
    expect(firstPage.flags).toEqual([expect.objectContaining({
      id: firstFlag.id,
      status: "open",
      question: "When does Atlas deploy?"
    })]);
    expect(firstPage.flags[0]).not.toHaveProperty("responseContent");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await client.callTool({
      name: "list_answer_flags",
      arguments: { limit: 1, cursor: firstPage.nextCursor }
    });
    const secondPage = JSON.parse(toolText(second));
    expect(secondPage.flags.map((flag: { id: string }) => flag.id)).toEqual([
      "00000000-0000-4000-8000-000000000002"
    ]);

    const reviewed = await client.callTool({
      name: "list_answer_flags",
      arguments: { status: "reviewed" }
    });
    const reviewedPage = JSON.parse(toolText(reviewed));
    expect(reviewedPage.flags).toEqual([expect.objectContaining({ status: "reviewed" })]);
    await transport.close();
  });

  it("gets the stored Answer Flag snapshot without model or allowance activity", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const { client, transport } = await ownerClient();

    const result = await client.callTool({
      name: "get_answer_flag",
      arguments: { flagId: firstFlag.id }
    });
    const snapshot = JSON.parse(toolText(result));

    expect(snapshot).toMatchObject({
      id: firstFlag.id,
      question: "When does Atlas deploy?",
      outcome: "answered",
      responseContent: firstFlag.response_content,
      sourceReferences: firstFlag.source_references,
      note: "Check the deployment day.",
      status: "open",
      respondedAt: "2026-11-06T08:00:00.000Z",
      createdAt: "2026-11-06T08:05:00.000Z"
    });
    expect(provider).not.toHaveBeenCalled();
    await transport.close();
  });

  it("rejects invalid status, page bounds, cursors, and identifiers before storage", async () => {
    const { client, transport } = await ownerClient();
    const callsBeforeValidation = database.calls;

    const invalidInputs = await Promise.all([
      client.callTool({ name: "list_answer_flags", arguments: { status: "all" } }),
      client.callTool({ name: "list_answer_flags", arguments: { limit: 51 } }),
      client.callTool({ name: "list_answer_flags", arguments: { cursor: "not-a-cursor" } }),
      client.callTool({ name: "get_answer_flag", arguments: { flagId: "not-an-id" } })
    ]);

    expect(invalidInputs.every((result) => result.isError === true)).toBe(true);
    expect(database.calls).toBe(callsBeforeValidation);
    await transport.close();
  });

  it("returns sanitized tool failures for missing records and database failures", async () => {
    process.env.ADMIN_SECRET = "admin-secret-must-not-leak";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-must-not-leak";
    const { client, transport } = await ownerClient();

    const missing = await client.callTool({
      name: "get_answer_flag",
      arguments: { flagId: "33333333-3333-4333-8333-333333333333" }
    });
    expect(missing.isError).toBe(true);
    expect(toolText(missing)).toBe("The Answer Flag could not be found.");

    database.error = { message: `database exploded ${ownerToken} admin-secret-must-not-leak service-role-must-not-leak` };
    const failed = await client.callTool({ name: "list_answer_flags", arguments: {} });
    const failureText = toolText(failed);
    expect(failed.isError).toBe(true);
    expect(failureText).toBe("Answer Flags could not be loaded.");
    expect(failureText).not.toContain(ownerToken);
    expect(failureText).not.toContain("admin-secret");
    expect(failureText).not.toContain("service-role");
    expect(failureText).not.toContain("database exploded");
    await transport.close();
    delete process.env.ADMIN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
});
