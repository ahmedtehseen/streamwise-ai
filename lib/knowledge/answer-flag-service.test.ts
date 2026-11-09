import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storedFlag = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
  response_id: "issued-response-1",
  question: "When does Atlas deploy?",
  outcome: "answered" as const,
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
  status: "open" as const,
  reviewed_at: null,
  created_at: "2026-11-06T08:05:00.000Z"
}));

const database = vi.hoisted(() => ({
  selectedColumns: "",
  requestedId: "",
  listStatus: "",
  listLimit: 0,
  listCursor: "",
  listRows: [] as Array<Record<string, unknown>>
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("answer_flags");
      return {
        select: (columns: string) => {
          database.selectedColumns = columns;
          return {
            eq: (column: string, value: string) => {
              if (column === "status") {
                database.listStatus = value;
                return {
                  order: () => ({
                    order: () => ({
                      or: (cursor: string) => {
                        database.listCursor = cursor;
                        return {
                          limit: async (limit: number) => {
                            database.listLimit = limit;
                            return { data: database.listRows, error: null };
                          }
                        };
                      },
                      limit: async (limit: number) => {
                        database.listLimit = limit;
                        return { data: database.listRows, error: null };
                      }
                    })
                  })
                };
              }
              database.requestedId = value;
              return {
                maybeSingle: async () => ({ data: value === storedFlag.id ? storedFlag : null, error: null })
              };
            },
          };
        }
      };
    }
  }))
}));

vi.mock("server-only", () => ({}));

describe("Answer Flag application service", () => {
  beforeEach(() => {
    database.selectedColumns = "";
    database.requestedId = "";
    database.listStatus = "";
    database.listLimit = 0;
    database.listCursor = "";
    database.listRows = [storedFlag];
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("returns one stored Answer Flag snapshot without rerunning the Portfolio Assistant", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const { getAnswerFlag } = await import("./answer-flag-service");

    const result = await getAnswerFlag({ flagId: storedFlag.id });

    expect(result).toEqual({
      ok: true,
      value: {
        id: storedFlag.id,
        responseId: "issued-response-1",
        question: "When does Atlas deploy?",
        outcome: "answered",
        responseContent: storedFlag.response_content,
        sourceReferences: storedFlag.source_references,
        respondedAt: "2026-11-06T08:00:00.000Z",
        note: "Check the deployment day.",
        status: "open",
        reviewedAt: null,
        createdAt: "2026-11-06T08:05:00.000Z"
      }
    });
    expect(database.requestedId).toBe(storedFlag.id);
    expect(provider).not.toHaveBeenCalled();
  });

  it("lists a bounded page of compact open Answer Flag summaries", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const { listAnswerFlagsPage } = await import("./answer-flag-service");

    const result = await listAnswerFlagsPage({ status: "open", limit: 10 });

    expect(result).toEqual({
      ok: true,
      value: {
        flags: [{
          id: storedFlag.id,
          question: "When does Atlas deploy?",
          outcome: "answered",
          status: "open",
          respondedAt: "2026-11-06T08:00:00.000Z",
          reviewedAt: null,
          createdAt: "2026-11-06T08:05:00.000Z"
        }],
        nextCursor: null
      }
    });
    expect(database.listStatus).toBe("open");
    expect(database.listLimit).toBe(11);
    expect(database.selectedColumns).not.toContain("response_content");
    expect(database.selectedColumns).not.toContain("source_references");
    expect(database.selectedColumns).not.toContain("visitor_note");
    expect(provider).not.toHaveBeenCalled();
  });

  it("continues past equal timestamps with an opaque cursor", async () => {
    const olderFlag = {
      ...storedFlag,
      id: "00000000-0000-4000-8000-000000000000",
      question: "What is Atlas?",
      created_at: "2026-11-06T08:04:00.000Z"
    };
    database.listRows = [storedFlag, olderFlag];
    const { listAnswerFlagsPage } = await import("./answer-flag-service");

    const firstPage = await listAnswerFlagsPage({ limit: 1 });

    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.flags.map((flag) => flag.id)).toEqual([storedFlag.id]);
    expect(firstPage.value.nextCursor).toEqual(expect.any(String));

    database.listRows = [olderFlag];
    const secondPage = await listAnswerFlagsPage({ limit: 1, cursor: firstPage.value.nextCursor! });

    expect(secondPage).toMatchObject({ ok: true, value: { flags: [{ id: olderFlag.id }], nextCursor: null } });
    expect(database.listCursor).toContain("created_at.lt.2026-11-06T08:05:00.000Z");
    expect(database.listCursor).toContain(`id.lt.${storedFlag.id}`);
  });

  it("rejects an invalid Answer Flag identifier before querying storage", async () => {
    const { getAnswerFlag } = await import("./answer-flag-service");

    const result = await getAnswerFlag({ flagId: "not-an-answer-flag-id" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_answer_flag_query",
        message: "Choose a valid Answer Flag identifier.",
        status: 400
      }
    });
    expect(database.requestedId).toBe("");
  });
});
