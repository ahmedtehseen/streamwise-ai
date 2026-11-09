import { z } from "zod";
import { listAnswerFlags, submitAnswerFlag } from "../../../../lib/knowledge/answer-flag-service";
import { verifyAdminAccess } from "../../../../lib/knowledge/server";

export const runtime = "nodejs";

const submissionSchema = z.object({
  responseId: z.string().min(1).max(65_536),
  note: z.string().max(500).optional()
}).strict();

export async function POST(request: Request) {
  const parsed = submissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Submit a valid response identity and an optional note of at most 500 characters." }, { status: 400 });
  }

  const result = await submitAnswerFlag(parsed.data);
  if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.status });
  return Response.json({ flag: result.value }, { status: 201 });
}

export async function GET(request: Request) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to review Answer Flags." }, { status: 401 });
  }
  const result = await listAnswerFlags();
  if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.status });
  return Response.json({ flags: result.value });
}
