import {
  exposeFailedIndexing,
  indexProjectDocument,
  ProjectDocumentRecord,
  publicProjectDocument
} from "../../../../../../lib/knowledge/indexing";
import { createKnowledgeClient, knowledgeConfiguration } from "../../../../../../lib/knowledge/server";

export const runtime = "nodejs";
type RetryProjectDocumentRecord = ProjectDocumentRecord & { original_text: string };

export async function POST(
  _request: Request,
  context: { params: Promise<{ documentId: string }> }
) {
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
    const readyDocument = await indexProjectDocument(
      client,
      indexingDocument.id,
      indexingDocument.original_text,
      indexingDocument.media_type === "text/markdown",
      configuration.geminiApiKey
    );
    return Response.json({ document: publicProjectDocument(readyDocument as ProjectDocumentRecord) });
  } catch (indexingError) {
    try {
      const failed = await exposeFailedIndexing(client, indexingDocument.id, indexingError);
      return Response.json({ error: failed.detail, document: publicProjectDocument(failed.document as ProjectDocumentRecord) }, { status: 502 });
    } catch {
      return Response.json({ error: "Indexing failed and the Project Document cleanup could not be confirmed." }, { status: 502 });
    }
  }
}
