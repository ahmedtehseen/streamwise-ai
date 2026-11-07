import {
  createKnowledgeClient,
  knowledgeDatabaseConfiguration,
  verifyAdminAccess
} from "../../../../../lib/knowledge/server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ flagId: string }> }
) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to review Answer Flags." }, { status: 401 });
  }
  const { flagId } = await context.params;
  if (!flagId) return Response.json({ error: "Choose an Answer Flag to review." }, { status: 400 });

  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client.rpc("review_answer_flag", { p_flag_id: flagId });
    if (error || !data) {
      return Response.json({ error: "The Answer Flag is missing or has already been reviewed." }, { status: 409 });
    }
    const flag = data as { id: string; status: "reviewed"; reviewed_at: string };
    return Response.json({
      flag: { id: flag.id, status: flag.status, reviewedAt: flag.reviewed_at }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Answer Flags are not configured." }, { status: 500 });
  }
}
