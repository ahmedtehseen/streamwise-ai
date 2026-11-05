import {
  createKnowledgeClient,
  knowledgeDatabaseConfiguration,
  verifyAdminAccess
} from "../../../../../lib/knowledge/server";
import { invalidateReadyDocumentCountCache } from "../../questions/route";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. An Admin Key is required to delete Project Documents." }, { status: 401 });
  }

  try {
    const { documentId } = await params;
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("project_documents")
      .delete()
      .eq("id", documentId)
      .eq("status", "ready")
      .select("id")
      .maybeSingle();

    if (error) return Response.json({ error: "The Project Document could not be deleted." }, { status: 502 });
    if (!data) return Response.json({ error: "The ready Project Document was not found." }, { status: 404 });
    invalidateReadyDocumentCountCache();
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }
}
