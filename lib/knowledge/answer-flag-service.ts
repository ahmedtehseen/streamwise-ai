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

export type AnswerFlagServiceError = {
  code: "invalid_response_identity" | "duplicate_answer_flag" | "answer_flag_not_found" |
    "answer_flag_conflict" | "answer_flags_unavailable" | "answer_flags_not_configured";
  message: string;
  status: 400 | 404 | 409 | 500 | 502;
};

export type AnswerFlagServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AnswerFlagServiceError };

const selectedColumns = "id,response_id,question,outcome,response_content,source_references,responded_at,visitor_note,status,reviewed_at,created_at";

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

function notConfigured(error: unknown): AnswerFlagServiceResult<never> {
  return {
    ok: false,
    error: {
      code: "answer_flags_not_configured",
      message: error instanceof Error ? error.message : "Answer Flags are not configured.",
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

export async function getAnswerFlag(input: { flagId: string }): Promise<AnswerFlagServiceResult<AnswerFlag>> {
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("answer_flags")
      .select(selectedColumns)
      .eq("id", input.flagId)
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
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client.rpc("review_answer_flag", { p_flag_id: input.flagId });
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
