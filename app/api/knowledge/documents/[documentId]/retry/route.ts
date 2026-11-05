import { ProjectDocumentRecord, publicProjectDocument, runProjectDocumentIndexing } from "../../../../../../lib/knowledge/indexing";
import { createKnowledgeClient, knowledgeConfiguration, verifyAdminAccess } from "../../../../../../lib/knowledge/server";

export const runtime = "nodejs";
type RetryProjectDocumentRecord = ProjectDocumentRecord & { original_text: string };

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> }
) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. An Admin Key is required to retry Project Document indexing." }, { status: 401 });
  }

  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }

  const { documentId } = await context.params;
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const { data, error } = await client.rpc("retry_project_document_indexing", { p_document_id: documentId });
  if (error || !data) {
    return Response.json({ error: "This Project Document is not available for retry." }, { status: 409 });
  }
  const indexingDocument = data as RetryProjectDocumentRecord;

  try {
    const result = await runProjectDocumentIndexing(
      client,
      indexingDocument.id,
      indexingDocument.original_text,
      indexingDocument.media_type === "text/markdown",
      configuration.geminiApiKey
    );
    if (result.outcome === "failed") {
      return Response.json({ error: result.detail, document: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 502 });
    }
    return Response.json({ document: publicProjectDocument(result.document as ProjectDocumentRecord) });
  } catch {
    return Response.json({ error: "Indexing failed and the Project Document cleanup could not be confirmed." }, { status: 502 });
  }
}
