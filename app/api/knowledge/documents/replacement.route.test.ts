import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  documents: [] as Array<Record<string, unknown>>,
  chunksByDocument: new Map<string, Array<Record<string, unknown>>>(),
  rpcCalls: [] as Array<{ name: string; parameters: Record<string, unknown> }>,
  failEmbeddings: false
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("project_documents");
      return {
        select: () => ({ order: async () => ({ data: database.documents, error: null }) }),
        delete: () => ({
          eq: (_idColumn: string, documentId: string) => ({
            eq: (_statusColumn: string, status: string) => ({
              select: () => ({
                maybeSingle: async () => {
                  const current = database.documents.find((item) => item.id === documentId && item.status === status);
                  if (!current) return { data: null, error: null };
                  const removedIds = new Set([documentId, ...database.documents.filter((item) => item.replaces_document_id === documentId).map((item) => String(item.id))]);
                  database.documents = database.documents.filter((item) => !removedIds.has(String(item.id)));
                  for (const id of removedIds) database.chunksByDocument.delete(id);
                  return { data: { id: documentId }, error: null };
                }
              })
            })
          })
        })
      };
    },
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      database.rpcCalls.push({ name, parameters });
      if (name === "begin_project_document_replacement") {
        const current = database.documents.find((item) => item.id === parameters.p_document_id && item.status === "ready" && !item.replaces_document_id);
        if (!current) return { data: null, error: { message: "not replaceable" } };
        const candidate = parameters.p_document as Record<string, unknown>;
        if (database.documents.some((item) => item.content_fingerprint === candidate.content_fingerprint)) {
          return { data: null, error: { code: "23505", message: "content_fingerprint duplicate" } };
        }
        if (database.documents.some((item) => item.replaces_document_id === current.id)) {
          return { data: null, error: { code: "23505", message: "DOCUMENT_REPLACEMENT_PENDING" } };
        }
        const replacement = {
          id: "replacement-1",
          ...candidate,
          replaces_document_id: current.id,
          status: "indexing",
          failure_detail: null,
          failure_retryable: false,
          created_at: "2026-11-06T08:00:00.000Z",
          updated_at: "2026-11-06T08:00:00.000Z"
        };
        database.documents.push(replacement);
        return { data: replacement, error: null };
      }
      if (name === "complete_project_document_indexing") {
        const replacement = database.documents.find((item) => item.id === parameters.p_document_id);
        if (!replacement) return { data: null, error: { message: "not found" } };
        const supersededId = String(replacement.replaces_document_id);
        database.chunksByDocument.set(String(replacement.id), parameters.p_chunks as Array<Record<string, unknown>>);
        replacement.status = "ready";
        replacement.replaces_document_id = null;
        database.documents = database.documents.filter((item) => item.id !== supersededId);
        database.chunksByDocument.delete(supersededId);
        return { data: replacement, error: null };
      }
      if (name === "fail_project_document_indexing") {
        const replacement = database.documents.find((item) => item.id === parameters.p_document_id);
        if (!replacement) return { data: null, error: { message: "not found" } };
        replacement.status = "failed";
        replacement.failure_detail = parameters.p_failure_detail;
        replacement.failure_retryable = parameters.p_failure_retryable;
        database.chunksByDocument.delete(String(replacement.id));
        return { data: replacement, error: null };
      }
      if (name === "retry_project_document_replacement") {
        const replacement = database.documents.find((item) => item.replaces_document_id === parameters.p_document_id && item.status === "failed" && item.failure_retryable === true);
        if (!replacement) return { data: null, error: { message: "not retryable" } };
        replacement.status = "indexing";
        replacement.failure_detail = null;
        replacement.failure_retryable = false;
        return { data: replacement, error: null };
      }
      if (name === "discard_project_document_replacement") {
        const replacement = database.documents.find((item) => item.replaces_document_id === parameters.p_document_id && item.status === "failed");
        if (!replacement) return { data: null, error: { message: "not discardable" } };
        database.documents = database.documents.filter((item) => item.id !== replacement.id);
        database.chunksByDocument.delete(String(replacement.id));
        return { data: replacement, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
  }))
}));

vi.mock("server-only", () => ({}));

describe("Project Document Replacement API", () => {
  beforeEach(() => {
    vi.resetModules();
    database.documents = [{
      id: "document-1",
      knowledge_base_id: "00000000-0000-0000-0000-000000000001",
      name: "atlas-old.txt",
      media_type: "text/plain",
      byte_size: 18,
      content_fingerprint: "a".repeat(64),
      status: "ready",
      failure_detail: null,
      failure_retryable: false,
      replaces_document_id: null,
      created_at: "2026-11-03T08:00:00.000Z",
      updated_at: "2026-11-03T08:00:01.000Z"
    }];
    database.chunksByDocument = new Map([["document-1", [{ text: "Old evidence" }]]]);
    database.rpcCalls = [];
    database.failEmbeddings = false;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] }
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ADMIN_SECRET;
  });

  it("activates a successfully processed Document Replacement and removes superseded evidence", async () => {
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));

    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(
      new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }),
      { params: Promise.resolve({ documentId: "document-1" }) }
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      document: { id: "replacement-1", name: "atlas-new.txt", status: "ready" }
    });
    expect(database.documents.map((document) => document.id)).toEqual(["replacement-1"]);
    expect(database.chunksByDocument.has("document-1")).toBe(false);
  });

  it("keeps the current Project Document ready and searchable when replacement processing fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));

    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(
      new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }),
      { params: Promise.resolve({ documentId: "document-1" }) }
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ replacement: { id: "replacement-1", status: "failed", retryable: true } });
    expect(database.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "document-1", status: "ready" }),
      expect.objectContaining({ id: "replacement-1", status: "failed", replaces_document_id: "document-1" })
    ]));
    expect(database.chunksByDocument.get("document-1")).toEqual([{ text: "Old evidence" }]);
  });

  it("retries a failed Document Replacement and activates it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));
    const replacementRoute = await import("./[documentId]/replacement/route");
    await replacementRoute.POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: { values: [1, ...Array.from({ length: 767 }, () => 0)] } })));

    const retryRoute = await import("./[documentId]/replacement/retry/route");
    const response = await retryRoute.POST(
      new Request("http://localhost/api/knowledge/documents/document-1/replacement/retry", { method: "POST" }),
      { params: Promise.resolve({ documentId: "document-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ document: { id: "replacement-1", status: "ready" } });
    expect(database.documents.map((item) => item.id)).toEqual(["replacement-1"]);
  });

  it("discards a failed Document Replacement without affecting current evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));
    const replacementRoute = await import("./[documentId]/replacement/route");
    await replacementRoute.POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });

    const { DELETE } = await import("./[documentId]/replacement/route");
    const response = await DELETE(
      new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "DELETE" }),
      { params: Promise.resolve({ documentId: "document-1" }) }
    );

    expect(response.status).toBe(204);
    expect(database.documents).toEqual([expect.objectContaining({ id: "document-1", status: "ready" })]);
    expect(database.chunksByDocument.get("document-1")).toEqual([{ text: "Old evidence" }]);
  });

  it("allows only one of two concurrent Document Replacement proposals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const route = await import("./[documentId]/replacement/route");
    const requestFor = (content: string) => {
      const formData = new FormData();
      formData.set("document", new File([content], `${content}.txt`, { type: "text/plain" }));
      return new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData });
    };
    const responses = await Promise.all([
      route.POST(requestFor("candidate one"), { params: Promise.resolve({ documentId: "document-1" }) }),
      route.POST(requestFor("candidate two"), { params: Promise.resolve({ documentId: "document-1" }) })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([409, 502]);
  });

  it("accepts a replacement when twenty active Project Documents fill capacity", async () => {
    database.documents.push(...Array.from({ length: 19 }, (_, index) => ({
      ...database.documents[0], id: `document-${index + 2}`, name: `document-${index + 2}.txt`, content_fingerprint: String(index + 1).padStart(64, "0")
    })));
    const formData = new FormData();
    formData.set("document", new File(["Capacity-safe replacement."], "replacement.txt", { type: "text/plain" }));
    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });
    expect(response.status).toBe(201);
    expect(database.documents).toHaveLength(20);
  });

  it("rejects replacement content that duplicates an existing Project Document", async () => {
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "duplicate.txt", { type: "text/plain" }));
    const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("New Atlas evidence."));
    database.documents.push({ ...database.documents[0], id: "document-2", content_fingerprint: Array.from(new Uint8Array(fingerprint)).map((byte) => byte.toString(16).padStart(2, "0")).join("") });
    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "An identical Project Document is already in the Knowledge Base." });
  });

  it("fails replacement mutation closed in production when the owner secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));
    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });
    expect(response.status).toBe(401);
    expect(database.rpcCalls).toEqual([]);
  });

  it("accepts replacement mutation with the valid owner secret", async () => {
    process.env.ADMIN_SECRET = "owner-secret";
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));
    const { POST } = await import("./[documentId]/replacement/route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", {
      method: "POST",
      headers: { "x-admin-key": "owner-secret" },
      body: formData
    }), { params: Promise.resolve({ documentId: "document-1" }) });
    expect(response.status).toBe(201);
  });

  it("deleting the current Project Document also removes its pending replacement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const formData = new FormData();
    formData.set("document", new File(["New Atlas evidence."], "atlas-new.txt", { type: "text/plain" }));
    const replacementRoute = await import("./[documentId]/replacement/route");
    await replacementRoute.POST(new Request("http://localhost/api/knowledge/documents/document-1/replacement", { method: "POST", body: formData }), { params: Promise.resolve({ documentId: "document-1" }) });
    const documentRoute = await import("./[documentId]/route");
    const response = await documentRoute.DELETE(new Request("http://localhost/api/knowledge/documents/document-1", { method: "DELETE" }), { params: Promise.resolve({ documentId: "document-1" }) });
    expect(response.status).toBe(204);
    expect(database.documents).toEqual([]);
    expect(database.chunksByDocument.size).toBe(0);
  });

  it("lists a pending Document Replacement with its current Project Document", async () => {
    database.documents.push({
      ...database.documents[0],
      id: "replacement-1",
      name: "atlas-new.txt",
      status: "failed",
      failure_detail: "Gemini is temporarily unavailable.",
      failure_retryable: true,
      replaces_document_id: "document-1"
    });
    const { GET } = await import("./route");
    const response = await GET();
    await expect(response.json()).resolves.toMatchObject({
      documents: [{
        id: "document-1",
        status: "ready",
        replacement: { id: "replacement-1", name: "atlas-new.txt", status: "failed", retryable: true }
      }]
    });
  });
});
