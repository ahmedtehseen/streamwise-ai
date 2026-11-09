import "server-only";

import { z } from "zod";
import {
  answerResponseFingerprint,
  verifyAnswerResponseIdentity
} from "./answer-flags";
import {
  createKnowledgeClient,
  knowledgeDatabaseConfiguration
} from "./server";

const sourceReferenceSchema = z.object({
  id: z.string().min(1),
  documentName: z.string().min(1),
  headingPath: z.array(z.string()),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1)
});

const responseContentSchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string(),
    sourceReferences: z.array(sourceReferenceSchema)
  })),
  degradedSearch: z.boolean()
});

const answerFlagRecordSchema = z.object({
  id: z.string().min(1),
  response_id: z.string().nullable(),
  question: z.string(),
  outcome: z.enum(["answered", "insufficient_evidence"]),
  response_content: responseContentSchema,
  source_references: z.array(sourceReferenceSchema),
  responded_at: z.string(),
  visitor_note: z.string().nullable(),
  status: z.enum(["open", "reviewed"]),
  reviewed_at: z.string().nullable(),
  created_at: z.string()
});

const reviewedFlagSchema = z.object({
  id: z.string().min(1),
  status: z.literal("reviewed"),
  reviewed_at: z.string()
});

export type AnswerFlag = {
  id: string;
  responseId: string | null;
  question: string;
  outcome: "answered" | "insufficient_evidence";
  responseContent: z.infer<typeof responseContentSchema>;
  sourceReferences: Array<z.infer<typeof sourceReferenceSchema>>;
  respondedAt: string;
  note: string | null;
  status: "open" | "reviewed";
  reviewedAt: string | null;
  createdAt: string;
};

export type AnswerFlagSummary = Pick<
  AnswerFlag,
  "id" | "question" | "outcome" | "status" | "respondedAt" | "reviewedAt" | "createdAt"
>;

export type AnswerFlagServiceError = {
  code: "invalid_response_identity" | "invalid_answer_flag_query" | "duplicate_answer_flag" | "answer_flag_not_found" |
    "answer_flag_conflict" | "answer_flags_unavailable" | "answer_flags_not_configured";
  message: string;
  status: 400 | 404 | 409 | 500 | 502;
};

export type AnswerFlagServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AnswerFlagServiceError };

const selectedColumns = "id,response_id,question,outcome,response_content,source_references,responded_at,visitor_note,status,reviewed_at,created_at";
const summaryColumns = "id,question,outcome,responded_at,status,reviewed_at,created_at";

const answerFlagSummaryRecordSchema = answerFlagRecordSchema.pick({
  id: true,
  question: true,
  outcome: true,
  responded_at: true,
  status: true,
  reviewed_at: true,
  created_at: true
});

const answerFlagPageInputSchema = z.object({
  status: z.enum(["open", "reviewed"]).default("open"),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2_048).optional()
});

const answerFlagCursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/)
}).strict();

function encodeAnswerFlagCursor(record: { created_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: record.created_at, id: record.id })).toString("base64url");
}

function decodeAnswerFlagCursor(cursor: string) {
  try {
    return answerFlagCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function publicAnswerFlag(record: z.infer<typeof answerFlagRecordSchema>): AnswerFlag {
  return {
    id: record.id,
    responseId: record.response_id,
    question: record.question,
    outcome: record.outcome,
    responseContent: record.response_content,
    sourceReferences: record.source_references,
    respondedAt: record.responded_at,
    note: record.visitor_note,
    status: record.status,
    reviewedAt: record.reviewed_at,
    createdAt: record.created_at
  };
}

function notConfigured(_error: unknown): AnswerFlagServiceResult<never> {
  return {
    ok: false,
    error: {
      code: "answer_flags_not_configured",
      message: "Answer Flags are not configured.",
      status: 500
    }
  };
}

export async function submitAnswerFlag(input: {
  responseId: string;
  note?: string;
}): Promise<AnswerFlagServiceResult<{ id: string; status: "open"; createdAt: string }>> {
  let snapshot;
  try {
    snapshot = verifyAnswerResponseIdentity(input.responseId);
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    return {
      ok: false,
      error: { code: "invalid_response_identity", message: "The response identity could not be verified.", status: 400 }
    };
  }

  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const sourceReferences = snapshot.paragraphs.flatMap((paragraph) => paragraph.sourceReferences);
    const { data, error } = await client.rpc("submit_answer_flag", {
      p_flag: {
        response_id: input.responseId,
        response_fingerprint: answerResponseFingerprint(input.responseId),
        question: snapshot.question,
        outcome: snapshot.outcome,
        response_content: { paragraphs: snapshot.paragraphs, degradedSearch: snapshot.degradedSearch },
        source_references: sourceReferences,
        responded_at: snapshot.respondedAt,
        visitor_note: input.note?.trim() || null
      }
    });
    if (error?.code === "23505") {
      return {
        ok: false,
        error: { code: "duplicate_answer_flag", message: "This response has already been flagged.", status: 409 }
      };
    }
    const parsed = answerFlagRecordSchema.safeParse(data);
    if (error || !parsed.success || parsed.data.status !== "open") {
      return {
        ok: false,
        error: { code: "answer_flags_unavailable", message: "The Answer Flag could not be saved.", status: 502 }
      };
    }
    return {
      ok: true,
      value: { id: parsed.data.id, status: "open", createdAt: parsed.data.created_at }
    };
  } catch (error) {
    return notConfigured(error);
  }
}

export async function listAnswerFlags(): Promise<AnswerFlagServiceResult<AnswerFlag[]>> {
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client.from("answer_flags").select(selectedColumns).order("created_at", { ascending: false });
    const parsed = z.array(answerFlagRecordSchema).safeParse(data);
    if (error || !parsed.success) {
      return {
        ok: false,
        error: { code: "answer_flags_unavailable", message: "Answer Flags could not be loaded.", status: 502 }
      };
    }
    return { ok: true, value: parsed.data.map(publicAnswerFlag) };
  } catch (error) {
    return notConfigured(error);
  }
}

export async function listAnswerFlagsPage(input: {
  status?: "open" | "reviewed";
  limit?: number;
  cursor?: string;
} = {}): Promise<AnswerFlagServiceResult<{ flags: AnswerFlagSummary[]; nextCursor: string | null }>> {
  const parsedInput = answerFlagPageInputSchema.safeParse(input);
  const cursor = parsedInput.success && parsedInput.data.cursor
    ? decodeAnswerFlagCursor(parsedInput.data.cursor)
    : null;
  if (!parsedInput.success || (parsedInput.data.cursor && !cursor)) {
    return {
      ok: false,
      error: { code: "invalid_answer_flag_query", message: "Choose a valid Answer Flag page.", status: 400 }
    };
  }
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { status, limit } = parsedInput.data;
    let query = client
      .from("answer_flags")
      .select(summaryColumns)
      .eq("status", status)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor) {
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }
    const { data, error } = await query.limit(limit + 1);
    const parsed = z.array(answerFlagSummaryRecordSchema).safeParse(data);
    if (error || !parsed.success) {
      return {
        ok: false,
        error: { code: "answer_flags_unavailable", message: "Answer Flags could not be loaded.", status: 502 }
      };
    }
    const page = parsed.data.slice(0, limit);
    return {
      ok: true,
      value: {
        flags: page.map((record) => ({
          id: record.id,
          question: record.question,
          outcome: record.outcome,
          status: record.status,
          respondedAt: record.responded_at,
          reviewedAt: record.reviewed_at,
          createdAt: record.created_at
        })),
        nextCursor: parsed.data.length > limit ? encodeAnswerFlagCursor(page[page.length - 1]) : null
      }
    };
  } catch (error) {
    return notConfigured(error);
  }
}

export async function getAnswerFlag(input: { flagId: string }): Promise<AnswerFlagServiceResult<AnswerFlag>> {
  const parsedFlagId = z.string().uuid().safeParse(input.flagId);
  if (!parsedFlagId.success) {
    return {
      ok: false,
      error: {
        code: "invalid_answer_flag_query",
        message: "Choose a valid Answer Flag identifier.",
        status: 400
      }
    };
  }
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("answer_flags")
      .select(selectedColumns)
      .eq("id", parsedFlagId.data)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "answer_flags_unavailable", message: "The Answer Flag could not be loaded.", status: 502 }
      };
    }
    if (!data) {
      return {
        ok: false,
        error: { code: "answer_flag_not_found", message: "The Answer Flag could not be found.", status: 404 }
      };
    }
    const parsed = answerFlagRecordSchema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "answer_flags_unavailable", message: "The Answer Flag could not be loaded.", status: 502 }
      };
    }
    return { ok: true, value: publicAnswerFlag(parsed.data) };
  } catch (error) {
    return notConfigured(error);
  }
}

export async function reviewAnswerFlag(input: {
  flagId: string;
}): Promise<AnswerFlagServiceResult<{ id: string; status: "reviewed"; reviewedAt: string }>> {
  const parsedFlagId = z.string().uuid().safeParse(input.flagId);
  if (!parsedFlagId.success) {
    return {
      ok: false,
      error: {
        code: "invalid_answer_flag_query",
        message: "Choose a valid Answer Flag identifier.",
        status: 400
      }
    };
  }
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client.rpc("review_answer_flag", { p_flag_id: parsedFlagId.data });
    const parsed = reviewedFlagSchema.safeParse(data);
    if (error || !parsed.success) {
      return {
        ok: false,
        error: {
          code: "answer_flag_conflict",
          message: "The Answer Flag is missing or has already been reviewed.",
          status: 409
        }
      };
    }
    return {
      ok: true,
      value: { id: parsed.data.id, status: parsed.data.status, reviewedAt: parsed.data.reviewed_at }
    };
  } catch (error) {
    return notConfigured(error);
  }
}
