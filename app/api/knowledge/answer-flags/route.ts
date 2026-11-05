import { z } from "zod";
import {
  answerResponseFingerprint,
  verifyAnswerResponseIdentity
} from "../../../../lib/knowledge/answer-flags";
import {
  createKnowledgeClient,
  knowledgeDatabaseConfiguration,
  verifyAdminAccess
} from "../../../../lib/knowledge/server";

export const runtime = "nodejs";

const submissionSchema = z.object({
  responseId: z.string().min(1).max(65_536),
  note: z.string().max(500).optional()
}).strict();

type AnswerFlagRecord = {
  id: string;
  question: string;
  outcome: "answered" | "insufficient_evidence";
  response_content: { paragraphs: unknown[]; degradedSearch: boolean };
  source_references: unknown[];
  responded_at: string;
  visitor_note: string | null;
  status: "open" | "reviewed";
  reviewed_at: string | null;
  created_at: string;
};

function publicAnswerFlag(flag: AnswerFlagRecord) {
  return {
    id: flag.id,
    question: flag.question,
    outcome: flag.outcome,
    responseContent: flag.response_content,
    sourceReferences: flag.source_references,
    respondedAt: flag.responded_at,
    note: flag.visitor_note,
    status: flag.status,
    reviewedAt: flag.reviewed_at,
    createdAt: flag.created_at
  };
}
export async function POST(request: Request) {
  const parsed = submissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Submit a valid response identity and an optional note of at most 500 characters." }, { status: 400 });
  }

  let snapshot;
  try {
    snapshot = verifyAnswerResponseIdentity(parsed.data.responseId);
  } catch {
    return Response.json({ error: "The response identity could not be verified." }, { status: 400 });
  }
  if (!snapshot) return Response.json({ error: "The response identity could not be verified." }, { status: 400 });

  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const sourceReferences = snapshot.paragraphs.flatMap((paragraph) => paragraph.sourceReferences);
    const { data, error } = await client.rpc("submit_answer_flag", {
      p_flag: {
        response_fingerprint: answerResponseFingerprint(parsed.data.responseId),
        question: snapshot.question,
        outcome: snapshot.outcome,
        response_content: {
          paragraphs: snapshot.paragraphs,
          degradedSearch: snapshot.degradedSearch
        },
        source_references: sourceReferences,
        responded_at: snapshot.respondedAt,
        visitor_note: parsed.data.note?.trim() || null
      }
    });
    if (error?.code === "23505") {
      return Response.json({ error: "This response has already been flagged." }, { status: 409 });
    }
    if (error || !data) return Response.json({ error: "The Answer Flag could not be saved." }, { status: 502 });
    const flag = data as AnswerFlagRecord;
    return Response.json({
      flag: { id: flag.id, status: flag.status, createdAt: flag.created_at }
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Answer Flags are not configured." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to review Answer Flags." }, { status: 401 });
  }
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("answer_flags")
      .select("id,question,outcome,response_content,source_references,responded_at,visitor_note,status,reviewed_at,created_at")
      .order("created_at", { ascending: false });
    if (error) return Response.json({ error: "Answer Flags could not be loaded." }, { status: 502 });
    return Response.json({ flags: (data as AnswerFlagRecord[]).map(publicAnswerFlag) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Answer Flags are not configured." }, { status: 500 });
  }
}
