import { ProjectDocumentRecord, publicProjectDocument, runProjectDocumentIndexing } from "../../../../../../../lib/knowledge/indexing";
import { createKnowledgeClient, knowledgeConfiguration, verifyAdminAccess } from "../../../../../../../lib/knowledge/server";
import { invalidateReadyDocumentCountCache } from "../../../../questions/route";

export const runtime = "nodejs";
type RetryReplacementRecord = ProjectDocumentRecord & { original_text: string };

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to retry Document Replacements." }, { status: 401 });
  }
  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }
  const { documentId } = await context.params;
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const { data, error } = await client.rpc("retry_project_document_replacement", { p_document_id: documentId });
  if (error || !data) return Response.json({ error: "This Document Replacement is not available for retry." }, { status: 409 });
  const replacement = data as RetryReplacementRecord;
  try {
    const result = await runProjectDocumentIndexing(client, replacement.id, replacement.original_text, replacement.media_type === "text/markdown", configuration.geminiApiKey);
    if (result.outcome === "failed") {
      return Response.json({ error: result.detail, replacement: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 502 });
    }
    invalidateReadyDocumentCountCache();
    return Response.json({ document: publicProjectDocument(result.document as ProjectDocumentRecord) });
  } catch {
    return Response.json({ error: "Replacement indexing failed and cleanup could not be confirmed." }, { status: 502 });
  }
}
