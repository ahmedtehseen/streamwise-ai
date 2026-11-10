import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  readyDocumentCount: 0,
  countError: null as { message: string } | null,
  admittedActions: 0
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ count: database.readyDocumentCount, error: database.countError })
      })
    }),
    rpc: async (name: string) => {
      if (name === "admit_public_action") {
        database.admittedActions += 1;
        return { data: { admitted: true }, error: null };
      }
      return { data: [], error: null };
    }
  })
}));

async function ask(question: unknown = "When does Atlas deploy?", withIdentity = true) {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/knowledge/questions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withIdentity ? { "x-vercel-forwarded-for": "203.0.113.9" } : {})
    },
    body: JSON.stringify({ question })
  }));
}

describe("Portfolio Assistant REST allowance admission", () => {
  beforeEach(() => {
    database.readyDocumentCount = 0;
    database.countError = null;
    database.admittedActions = 0;
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("VISITOR_ID_SECRET", "visitor-id-test-secret-with-enough-entropy");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves the empty Knowledge Base outcome before allowance admission or identity checks", async () => {
    const response = await ask();
    const withoutIdentity = await ask("When does Atlas deploy?", false);

    expect(response.status).toBe(409);
    expect(withoutIdentity.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Index at least one Project Document before asking a question."
    });
    expect(database.admittedActions).toBe(0);
  });

  it("preserves configuration failures before allowance admission or identity checks", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const response = await ask();
    const withoutIdentity = await ask("When does Atlas deploy?", false);

    expect(response.status).toBe(500);
    expect(withoutIdentity.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Knowledge indexing requires GEMINI_API_KEY in .env.local." });
    expect(database.admittedActions).toBe(0);
  });

  it("preserves Knowledge Base check failures before allowance admission", async () => {
    database.countError = { message: "private database detail" };

    const response = await ask();
    const withoutIdentity = await ask("When does Atlas deploy?", false);

    expect(response.status).toBe(503);
    expect(withoutIdentity.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The Knowledge Base could not be checked.", code: "database_unavailable", retryable: true
    });
    expect(database.admittedActions).toBe(0);
  });

  it("rejects invalid questions without spending allowance", async () => {
    database.readyDocumentCount = 1;

    const response = await ask("  ");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Enter a project question." });
    expect(database.admittedActions).toBe(0);
  });

  it("admits exactly one public action for a ready Knowledge Base", async () => {
    database.readyDocumentCount = 1;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] }
    })));

    const response = await ask();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "insufficient_evidence", paragraphs: [] });
    expect(database.admittedActions).toBe(1);
  });
});
