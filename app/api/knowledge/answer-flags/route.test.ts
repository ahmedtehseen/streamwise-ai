import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StoredFlag = {
  id: string;
  response_id: string;
  response_fingerprint: string;
  question: string;
  outcome: "answered" | "insufficient_evidence";
  response_content: Record<string, unknown>;
  source_references: Array<Record<string, unknown>>;
  responded_at: string;
  visitor_note: string | null;
  status: "open" | "reviewed";
  reviewed_at: string | null;
  created_at: string;
};

const database = vi.hoisted(() => ({
  flags: [] as StoredFlag[],
  flagRpcCalls: [] as Array<{ name: string; parameters: Record<string, unknown> }>,
  questionOutcome: "answered" as "answered" | "insufficient_evidence",
  degradedSearch: false,
  reviewResult: null as { data: unknown; error: { message: string } | null } | null
}));

const answerFlagId = "11111111-1111-4111-8111-111111111111";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "project_documents") {
        return { select: () => ({ eq: async () => ({ count: 1, error: null }) }) };
      }
      if (table === "answer_flags") {
        return { select: () => ({ order: async () => ({ data: database.flags, error: null }) }) };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      if (name === "match_ready_document_chunks_hybrid" || name === "match_ready_document_chunks_full_text") {
        return {
          data: [{
            chunk_id: "chunk-1",
            document_name: "atlas.md",
            text: "Atlas deployments happen on Fridays.",
            heading_path: ["Atlas", "Launch"],
            start_line: 7,
            end_line: 7,
            cosine_distance: name.endsWith("full_text") ? 1 : 0.04,
            fts_rank: name.endsWith("full_text") ? 0.6 : 0
          }],
          error: null
        };
      }
      database.flagRpcCalls.push({ name, parameters });
      if (name === "submit_answer_flag") {
        const candidate = parameters.p_flag as StoredFlag;
        if (database.flags.some((flag) => flag.response_fingerprint === candidate.response_fingerprint)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const stored = {
          ...candidate,
          id: database.flags.length === 0
            ? answerFlagId
            : "22222222-2222-4222-8222-222222222222",
          status: "open" as const,
          reviewed_at: null,
          created_at: "2026-11-06T08:05:00.000Z"
        };
        database.flags.push(stored);
        return { data: stored, error: null };
      }
      if (name === "review_answer_flag") {
        if (database.reviewResult) return database.reviewResult;
        const flag = database.flags.find((item) => item.id === parameters.p_flag_id);
        if (!flag || flag.status !== "open") return { data: null, error: { message: "ANSWER_FLAG_NOT_OPEN" } };
        flag.status = "reviewed";
        flag.reviewed_at = "2026-11-06T09:00:00.000Z";
        return { data: flag, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
  }))
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/public-allowance", () => ({
  admitPublicAction: vi.fn(async () => null)
}));

describe("Answer Flag API", () => {
  beforeEach(() => {
    vi.resetModules();
    database.flags = [];
    database.flagRpcCalls = [];
    database.questionOutcome = "answered";
    database.degradedSearch = false;
    database.reviewResult = null;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.ADMIN_SECRET = "owner-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(":embedContent")) {
        if (database.degradedSearch) return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
        return Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(
        database.questionOutcome === "answered"
          ? { outcome: "answered", paragraphs: [{ text: "Atlas deploys on Fridays.", chunkIds: ["source-1"] }] }
          : { outcome: "insufficient_evidence", paragraphs: [] }
      ) }] } }] });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ADMIN_SECRET;
    delete process.env.GEMINI_API_KEY;
  });

  async function issuedResponse(
    outcome: "answered" | "insufficient_evidence",
    degradedSearch = false
  ) {
    database.questionOutcome = outcome;
    database.degradedSearch = degradedSearch;
    const { POST } = await import("../questions/route");
    const response = await POST(new Request("http://localhost/api/knowledge/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "When does Atlas deploy?" })
    }));
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      outcome: "answered" | "insufficient_evidence";
      paragraphs: Array<{ text: string; sourceReferences: Array<Record<string, unknown>> }>;
      degradedSearch?: boolean;
      responseId: string;
      respondedAt: string;
    }>;
  }

  async function submit(responseId: string, note?: unknown) {
    const { POST } = await import("./route");
    return POST(new Request("http://localhost/api/knowledge/answer-flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responseId, ...(note === undefined ? {} : { note }) })
    }));
  }

  it("accepts one anonymous Answer Flag for an issued Grounded Answer", async () => {
    const issued = await issuedResponse("answered");

    const response = await submit(issued.responseId, "The deployment day looks stale.");

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      flag: {
        id: answerFlagId,
        status: "open",
        createdAt: "2026-11-06T08:05:00.000Z"
      }
    });
    expect(database.flags).toHaveLength(1);
    expect(database.flags[0]).toMatchObject({
      response_id: issued.responseId,
      question: "When does Atlas deploy?",
      outcome: "answered",
      response_content: {
        paragraphs: issued.paragraphs,
        degradedSearch: false
      },
      source_references: issued.paragraphs[0].sourceReferences,
      responded_at: issued.respondedAt,
      visitor_note: "The deployment day looks stale.",
      status: "open"
    });
    expect(database.flags[0]).not.toHaveProperty("visitor_id");
    expect(database.flags[0]).not.toHaveProperty("ip_address");
  });

  it.each([
    ["answered", true],
    ["insufficient_evidence", false],
    ["insufficient_evidence", true]
  ] as const)("accepts an issued %s response when degraded search is %s", async (outcome, degradedSearch) => {
    const issued = await issuedResponse(outcome, degradedSearch);

    const response = await submit(issued.responseId);

    expect(response.status).toBe(201);
    expect(database.flags[0]).toMatchObject({
      outcome,
      response_content: { paragraphs: issued.paragraphs, degradedSearch },
      source_references: outcome === "answered" ? issued.paragraphs[0].sourceReferences : [],
      visitor_note: null
    });
  });

  it("rejects a forged response identity without storing an Answer Flag", async () => {
    const issued = await issuedResponse("answered");
    const [payload] = issued.responseId.split(".");

    const response = await submit(`${payload}.forged-signature`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "The response identity could not be verified." });
    expect(database.flags).toHaveLength(0);
  });

  it("rejects a second Answer Flag for the same issued response", async () => {
    const issued = await issuedResponse("answered");

    expect((await submit(issued.responseId)).status).toBe(201);
    const duplicate = await submit(issued.responseId, "A second report");

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: "This response has already been flagged." });
    expect(database.flags).toHaveLength(1);
  });

  it.each([
    [{ responseId: "" }, "missing identity"],
    [{ responseId: 42 }, "non-string identity"],
    [{ responseId: "not-issued", extra: true }, "unknown field"],
    [{ responseId: "not-issued", note: 42 }, "non-string note"],
    [{ responseId: "not-issued", note: "x".repeat(501) }, "oversized note"]
  ])("rejects a malformed submission with a $1", async (body, _caseName) => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/answer-flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(400);
    expect(database.flags).toHaveLength(0);
  });

  it("requires the Portfolio Owner secret before listing Answer Flags", async () => {
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/knowledge/answer-flags"));

    expect(response.status).toBe(401);
    expect(database.flagRpcCalls).toHaveLength(0);
  });

  it("lets the Portfolio Owner list both open and reviewed Answer Flags", async () => {
    const openIssued = await issuedResponse("answered");
    await submit(openIssued.responseId, "Check this answer.");
    const reviewedIssued = await issuedResponse("insufficient_evidence", true);
    await submit(reviewedIssued.responseId);
    database.flags[1].status = "reviewed";
    database.flags[1].reviewed_at = "2026-11-06T09:00:00.000Z";
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/knowledge/answer-flags", {
      headers: { "x-admin-key": "owner-test-key" }
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { flags: Array<Record<string, unknown>> };
    expect(payload.flags).toHaveLength(2);
    expect(payload.flags.map((flag) => flag.status)).toEqual(["open", "reviewed"]);
    expect(payload.flags[0]).toMatchObject({
      responseId: openIssued.responseId,
      question: "When does Atlas deploy?",
      outcome: "answered",
      note: "Check this answer.",
      status: "open"
    });
    expect(payload.flags[1]).toMatchObject({
      outcome: "insufficient_evidence",
      responseContent: { degradedSearch: true },
      status: "reviewed",
      reviewedAt: "2026-11-06T09:00:00.000Z"
    });
  });

  it("lets only the Portfolio Owner mark an open Answer Flag reviewed without changing its response", async () => {
    const issued = await issuedResponse("answered");
    await submit(issued.responseId, "Check this answer.");
    const originalSnapshot = structuredClone(database.flags[0].response_content);
    const { PATCH } = await import("./[flagId]/route");

    const unauthorized = await PATCH(
      new Request(`http://localhost/api/knowledge/answer-flags/${answerFlagId}`, { method: "PATCH" }),
      { params: Promise.resolve({ flagId: answerFlagId }) }
    );
    expect(unauthorized.status).toBe(401);

    const reviewed = await PATCH(
      new Request(`http://localhost/api/knowledge/answer-flags/${answerFlagId}`, {
        method: "PATCH",
        headers: { "x-admin-key": "owner-test-key" }
      }),
      { params: Promise.resolve({ flagId: answerFlagId }) }
    );

    expect(reviewed.status).toBe(200);
    await expect(reviewed.json()).resolves.toEqual({
      flag: {
        id: answerFlagId,
        status: "reviewed",
        reviewedAt: "2026-11-06T09:00:00.000Z"
      }
    });
    expect(database.flags[0].response_content).toEqual(originalSnapshot);
    expect(database.flags[0].status).toBe("reviewed");
  });

  it.each([
    ["RPC error", { data: null, error: { message: "private database detail" } }],
    ["missing result", { data: null, error: null }],
    ["invalid result", { data: { id: answerFlagId }, error: null }]
  ])("preserves the REST review conflict status for a storage %s", async (_caseName, result) => {
    database.reviewResult = result;
    const { PATCH } = await import("./[flagId]/route");

    const response = await PATCH(
      new Request(`http://localhost/api/knowledge/answer-flags/${answerFlagId}`, {
        method: "PATCH",
        headers: { "x-admin-key": "owner-test-key" }
      }),
      { params: Promise.resolve({ flagId: answerFlagId }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "The Answer Flag could not be reviewed." });
  });

  it("returns a conflict when the Answer Flag is missing or already reviewed", async () => {
    const { PATCH } = await import("./[flagId]/route");

    const response = await PATCH(
      new Request(`http://localhost/api/knowledge/answer-flags/${answerFlagId}`, {
        method: "PATCH",
        headers: { "x-admin-key": "owner-test-key" }
      }),
      { params: Promise.resolve({ flagId: answerFlagId }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The Answer Flag is missing or has already been reviewed."
    });
  });

  it("returns a configuration failure when Answer Flag storage is not configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { PATCH } = await import("./[flagId]/route");

    const response = await PATCH(
      new Request(`http://localhost/api/knowledge/answer-flags/${answerFlagId}`, {
        method: "PATCH",
        headers: { "x-admin-key": "owner-test-key" }
      }),
      { params: Promise.resolve({ flagId: answerFlagId }) }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Answer Flags are not configured." });
    expect(database.flagRpcCalls).toHaveLength(0);
  });

  it("rejects an invalid Answer Flag identifier before attempting the shared review transition", async () => {
    const { PATCH } = await import("./[flagId]/route");

    const response = await PATCH(
      new Request("http://localhost/api/knowledge/answer-flags/not-a-uuid", {
        method: "PATCH",
        headers: { "x-admin-key": "owner-test-key" }
      }),
      { params: Promise.resolve({ flagId: "not-a-uuid" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Choose a valid Answer Flag identifier."
    });
    expect(database.flagRpcCalls).toHaveLength(0);
  });
});
