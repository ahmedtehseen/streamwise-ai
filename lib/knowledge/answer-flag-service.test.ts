import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storedFlag = vi.hoisted(() => ({
  id: "flag-1",
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
  requestedId: ""
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("answer_flags");
      return {
        select: (columns: string) => {
          database.selectedColumns = columns;
          return {
            eq: (_column: string, id: string) => {
              database.requestedId = id;
              return {
                maybeSingle: async () => ({ data: id === storedFlag.id ? storedFlag : null, error: null })
              };
            }
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

    const result = await getAnswerFlag({ flagId: "flag-1" });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "flag-1",
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
    expect(database.requestedId).toBe("flag-1");
    expect(provider).not.toHaveBeenCalled();
  });
});
