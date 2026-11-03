import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  insertedDocument: null as Record<string, unknown> | null,
  completedChunks: [] as Array<Record<string, unknown>>,
  listedDocuments: [] as Array<Record<string, unknown>>,
  admissionError: null as null | { code: string; message: string },
  admittedFingerprints: new Set<string>(),
  rpcCalls: [] as Array<{ name: string; parameters: Record<string, unknown> }>,
  documentStatus: null as "indexing" | "ready" | "failed" | null,
  retryable: false,
  failCompletion: false
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("project_documents");
      return {
        select: () => ({
          order: async () => ({ data: database.listedDocuments, error: null })
        }),
        insert: (document: Record<string, unknown>) => {
          database.insertedDocument = document;
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: "document-1",
                  name: document.name,
                  media_type: document.media_type,
                  byte_size: document.byte_size,
                  status: "indexing",
                  created_at: "2026-11-03T08:00:00.000Z",
                  updated_at: "2026-11-03T08:00:00.000Z"
                },
                error: null
              })
            })
          };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({
          eq: (_column: string, documentId: string) => ({
            eq: (_statusColumn: string, status: string) => ({
              select: () => ({
                maybeSingle: async () => {
                  const existing = database.listedDocuments.find((document) => document.id === documentId && document.status === status);
                  if (!existing) return { data: null, error: null };
                  database.listedDocuments = database.listedDocuments.filter((document) => document.id !== documentId);
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
      if (name === "begin_project_document_indexing") {
        if (database.admissionError) return { data: null, error: database.admissionError };
        const document = parameters.p_document as Record<string, unknown>;
        const fingerprint = String(document.content_fingerprint);
        if (database.admittedFingerprints.has(fingerprint)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        database.admittedFingerprints.add(fingerprint);
        database.insertedDocument = document;
        database.documentStatus = "indexing";
        const admittedDocument = {
            id: `document-${database.listedDocuments.length + 1}`,
            name: document.name,
            media_type: document.media_type,
            byte_size: document.byte_size,
            status: "indexing",
            created_at: "2026-11-03T08:00:00.000Z",
            updated_at: "2026-11-03T08:00:00.000Z"
          };
        database.listedDocuments.unshift(admittedDocument);
        return { data: admittedDocument, error: null };
      }
      if (name === "retry_project_document_indexing") {
        if (database.documentStatus !== "failed" || !database.retryable) return { data: null, error: { message: "not retryable" } };
        database.documentStatus = "indexing";
        database.retryable = false;
        const indexingDocument = {
          id: "document-1",
          name: database.insertedDocument?.name,
          media_type: database.insertedDocument?.media_type,
          byte_size: database.insertedDocument?.byte_size,
          original_text: database.insertedDocument?.original_text,
          status: "indexing",
          failure_detail: null,
          failure_retryable: false,
          created_at: "2026-11-03T08:00:00.000Z",
          updated_at: "2026-11-03T08:00:02.000Z"
        };
        database.listedDocuments = database.listedDocuments.map((document) => document.id === indexingDocument.id ? indexingDocument : document);
        return { data: indexingDocument, error: null };
      }
      if (name === "fail_project_document_indexing") {
        database.documentStatus = "failed";
        database.retryable = parameters.p_failure_retryable === true;
        database.completedChunks = [];
        const failedDocument = {
          id: String(parameters.p_document_id),
          name: database.insertedDocument?.name,
          media_type: database.insertedDocument?.media_type,
          byte_size: database.insertedDocument?.byte_size,
          status: "failed",
          failure_detail: parameters.p_failure_detail,
          failure_retryable: parameters.p_failure_retryable,
          created_at: "2026-11-03T08:00:00.000Z",
          updated_at: "2026-11-03T08:00:01.000Z"
        };
        database.listedDocuments = database.listedDocuments.map((document) => document.id === failedDocument.id ? failedDocument : document);
        return { data: failedDocument, error: null };
      }
      expect(name).toBe("complete_project_document_indexing");
      if (database.failCompletion) return { data: null, error: { message: "database unavailable" } };
      database.documentStatus = "ready";
      database.completedChunks = parameters.p_chunks as Array<Record<string, unknown>>;
      const completedDocument = {
          id: String(parameters.p_document_id),
          name: database.insertedDocument?.name,
          media_type: database.insertedDocument?.media_type,
          byte_size: database.insertedDocument?.byte_size,
          status: "ready",
          created_at: "2026-11-03T08:00:00.000Z",
          updated_at: "2026-11-03T08:00:01.000Z"
        };
      database.listedDocuments = database.listedDocuments.map((document) => document.id === completedDocument.id ? completedDocument : document);
      return { data: completedDocument, error: null };
    }
  }))
}));

vi.mock("server-only", () => ({}));

describe("Knowledge Project Document API", () => {
  beforeEach(() => {
    vi.resetModules();
    database.insertedDocument = null;
    database.completedChunks = [];
    database.listedDocuments = [];
    database.admissionError = null;
    database.admittedFingerprints.clear();
    database.rpcCalls = [];
    database.documentStatus = null;
    database.retryable = false;
    database.failCompletion = false;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("indexes a Markdown Project Document with trusted source locators", async () => {
    const embeddingRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      embeddingRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } });
    }));

    const formData = new FormData();
    formData.set("document", new File([
      "# Atlas\n\nAtlas keeps deployment notes.\n\n## Launch\n\nDeploy on Fridays."
    ], "atlas.md", { type: "text/markdown" }));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.document).toMatchObject({ name: "atlas.md", status: "ready" });
    expect(database.insertedDocument).toMatchObject({
      name: "atlas.md",
      media_type: "text/markdown",
      byte_size: 69,
      status: "indexing",
      original_text: "# Atlas\n\nAtlas keeps deployment notes.\n\n## Launch\n\nDeploy on Fridays."
    });
    expect(database.completedChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Atlas keeps deployment notes.", heading_path: ["Atlas"], start_line: 3, end_line: 3 }),
      expect.objectContaining({ text: "Deploy on Fridays.", heading_path: ["Atlas", "Launch"], start_line: 7, end_line: 7 })
    ]));
    expect(database.completedChunks.every((chunk) => chunk.embedding_model === "gemini-embedding-2" && chunk.embedding_dimension === 768 && Array.isArray(chunk.embedding) && chunk.embedding.length === 768)).toBe(true);
    expect(embeddingRequests).toHaveLength(database.completedChunks.length);
    expect(embeddingRequests.every((body) => body.output_dimensionality === 768 && JSON.stringify(body).includes("Document: "))).toBe(true);
  });

  it("lists a ready Project Document from durable storage after reload", async () => {
    database.listedDocuments = [{
      id: "document-1",
      name: "atlas.md",
      media_type: "text/markdown",
      byte_size: 69,
      status: "ready",
      failure_detail: null,
      created_at: "2026-11-03T08:00:00.000Z",
      updated_at: "2026-11-03T08:00:01.000Z"
    }];

    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      documents: [{
        id: "document-1",
        name: "atlas.md",
        mediaType: "text/markdown",
        byteSize: 69,
        status: "ready",
        failureDetail: null,
        retryable: false,
        createdAt: "2026-11-03T08:00:00.000Z",
        updatedAt: "2026-11-03T08:00:01.000Z"
      }]
    });
  });

  it("deletes a ready Project Document and its chunks through durable cascading deletion", async () => {
    database.listedDocuments = [{
      id: "document-1",
      name: "atlas.md",
      media_type: "text/markdown",
      byte_size: 69,
      status: "ready",
      created_at: "2026-11-03T08:00:00.000Z",
      updated_at: "2026-11-03T08:00:01.000Z"
    }];
    const { DELETE } = await import("./[documentId]/route");
    const response = await DELETE(
      new Request("http://localhost/api/knowledge/documents/document-1", { method: "DELETE" }),
      { params: Promise.resolve({ documentId: "document-1" }) }
    );

    expect(response.status).toBe(204);
    const { GET } = await import("./route");
    await expect((await GET()).json()).resolves.toEqual({ documents: [] });
  });

  it("rejects a binary-looking Project Document without creating durable records", async () => {
    const formData = new FormData();
    formData.set("document", new File([new Uint8Array([65, 0, 66, 0, 67])], "binary.txt", { type: "text/plain" }));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "The Project Document appears to contain binary content." });
    const { GET } = await import("./route");
    await expect((await GET()).json()).resolves.toEqual({ documents: [] });
  });

  it.each([
    {
      caseName: "empty",
      file: () => new File(["   \n"], "empty.txt", { type: "text/plain" }),
      status: 400,
      error: "The Project Document is empty."
    },
    {
      caseName: "unsupported",
      file: () => new File(["PDF-like content"], "brief.pdf", { type: "application/pdf" }),
      status: 415,
      error: "Use a Markdown (.md) or plain-text (.txt) Project Document."
    },
    {
      caseName: "oversized",
      file: () => new File(["x".repeat((500 * 1024) + 1)], "large.txt", { type: "text/plain" }),
      status: 413,
      error: "Keep the Project Document at or below 500 KB."
    }
  ])("rejects a $caseName Project Document without creating durable records", async ({ file, status, error }) => {
    const formData = new FormData();
    formData.set("document", file());

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    const { GET } = await import("./route");
    await expect((await GET()).json()).resolves.toEqual({ documents: [] });
  });

  it("rejects a Project Document when the shared Knowledge Base has reached its 20-document capacity", async () => {
    database.admissionError = { code: "P0001", message: "KNOWLEDGE_BASE_CAPACITY" };
    const formData = new FormData();
    formData.set("document", new File(["Project notes"], "notes.txt", { type: "text/plain" }));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "The Knowledge Base can contain at most 20 Project Documents." });
    const { GET } = await import("./route");
    await expect((await GET()).json()).resolves.toEqual({ documents: [] });
  });

  it("rejects identical content as a duplicate regardless of filename", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } })));
    const { POST } = await import("./route");
    const firstForm = new FormData();
    firstForm.set("document", new File(["The same project knowledge."], "first.txt", { type: "text/plain" }));
    const secondForm = new FormData();
    secondForm.set("document", new File(["The same project knowledge."], "renamed.txt", { type: "text/plain" }));

    const firstResponse = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: firstForm }));
    const secondResponse = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: secondForm }));

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toEqual({ error: "An identical Project Document is already in the Knowledge Base." });
    const { GET } = await import("./route");
    const listed = await (await GET()).json() as { documents: Array<{ name: string; status: string }> };
    expect(listed.documents).toEqual([expect.objectContaining({ name: "first.txt", status: "ready" })]);
  });

  it("allows only one of two concurrent identical upload attempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } })));
    const { POST } = await import("./route");
    const requestFor = (name: string) => {
      const formData = new FormData();
      formData.set("document", new File(["Concurrent project knowledge."], name, { type: "text/plain" }));
      return new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData });
    };

    const responses = await Promise.all([POST(requestFor("one.txt")), POST(requestFor("two.txt"))]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const { GET } = await import("./route");
    const listed = await (await GET()).json() as { documents: Array<{ status: string }> };
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0].status).toBe("ready");
  });

  it("keeps a transient embedding failure visible after cleaning partial chunks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("throttled", { status: 429 })));
    const formData = new FormData();
    formData.set("document", new File(["Atlas deployment notes."], "atlas.txt", { type: "text/plain" }));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "Gemini is temporarily unable to embed this Project Document. Try again.",
      document: { id: "document-1", status: "failed", retryable: true }
    });
    expect(database.rpcCalls.at(-1)).toMatchObject({
      name: "fail_project_document_indexing",
      parameters: { p_document_id: "document-1", p_failure_retryable: true }
    });
    expect(database.completedChunks).toEqual([]);
  });

  it("retries the same failed Project Document through indexing to ready", async () => {
    let embeddingAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      embeddingAttempt += 1;
      if (embeddingAttempt === 1) return new Response("temporarily unavailable", { status: 503 });
      return Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } });
    }));
    const formData = new FormData();
    formData.set("document", new File(["Atlas deployment notes."], "atlas.txt", { type: "text/plain" }));

    const documentsRoute = await import("./route");
    const failedResponse = await documentsRoute.POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));
    const failed = await failedResponse.json();
    const retryRoute = await import("./[documentId]/retry/route");
    const retryResponse = await retryRoute.POST(
      new Request("http://localhost/api/knowledge/documents/document-1/retry", { method: "POST" }),
      { params: Promise.resolve({ documentId: failed.document.id }) }
    );

    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toMatchObject({
      document: { id: "document-1", name: "atlas.txt", status: "ready", retryable: false }
    });
    expect(database.insertedDocument).toMatchObject({ name: "atlas.txt" });
    expect(database.rpcCalls.map((call) => call.name)).toEqual([
      "begin_project_document_indexing",
      "fail_project_document_indexing",
      "retry_project_document_indexing",
      "complete_project_document_indexing"
    ]);
  });

  it("does not offer retry for a permanent embedding failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: { values: [1, 0] } })));
    const formData = new FormData();
    formData.set("document", new File(["Atlas deployment notes."], "atlas.txt", { type: "text/plain" }));

    const documentsRoute = await import("./route");
    const failedResponse = await documentsRoute.POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));
    const failed = await failedResponse.json();
    const retryRoute = await import("./[documentId]/retry/route");
    const retryResponse = await retryRoute.POST(
      new Request("http://localhost/api/knowledge/documents/document-1/retry", { method: "POST" }),
      { params: Promise.resolve({ documentId: failed.document.id }) }
    );

    expect(failed.document).toMatchObject({ status: "failed", retryable: false });
    expect(failed.error).toContain("invalid Project Document embedding");
    expect(retryResponse.status).toBe(409);
  });

  it("keeps a database completion failure retryable after cleanup", async () => {
    database.failCompletion = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } })));
    const formData = new FormData();
    formData.set("document", new File(["Atlas deployment notes."], "atlas.txt", { type: "text/plain" }));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ document: { status: "failed", retryable: true } });
    expect(database.rpcCalls.map((call) => call.name)).toEqual([
      "begin_project_document_indexing",
      "complete_project_document_indexing",
      "fail_project_document_indexing"
    ]);
    expect(database.completedChunks).toEqual([]);
  });

  it("allows only one of two repeated retry requests to complete", async () => {
    let embeddingAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      embeddingAttempt += 1;
      if (embeddingAttempt === 1) return new Response("temporarily unavailable", { status: 503 });
      return Response.json({ embedding: { values: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) } });
    }));
    const formData = new FormData();
    formData.set("document", new File(["Atlas deployment notes."], "atlas.txt", { type: "text/plain" }));
    const documentsRoute = await import("./route");
    await documentsRoute.POST(new Request("http://localhost/api/knowledge/documents", { method: "POST", body: formData }));
    const retryRoute = await import("./[documentId]/retry/route");
    const context = { params: Promise.resolve({ documentId: "document-1" }) };

    const [firstRetry, secondRetry] = await Promise.all([
      retryRoute.POST(new Request("http://localhost/api/knowledge/documents/document-1/retry", { method: "POST" }), context),
      retryRoute.POST(new Request("http://localhost/api/knowledge/documents/document-1/retry", { method: "POST" }), context)
    ]);

    expect([firstRetry.status, secondRetry.status].sort()).toEqual([200, 409]);
    expect(database.completedChunks).toHaveLength(1);
  });
});
