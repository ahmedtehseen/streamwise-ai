import { ProjectDocumentRecord, publicProjectDocument, runProjectDocumentIndexing } from "../../../../../../lib/knowledge/indexing";
import { ProjectDocumentIntakeError, readProjectDocument } from "../../../../../../lib/knowledge/document-intake";
import { createKnowledgeClient, KNOWLEDGE_BASE_ID, knowledgeConfiguration, knowledgeDatabaseConfiguration, verifyAdminAccess } from "../../../../../../lib/knowledge/server";
import { invalidateReadyDocumentCountCache } from "../../../questions/route";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to replace Project Documents." }, { status: 401 });
  }

  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }

  const formData = await request.formData().catch(() => null);
  const documentFile = formData?.get("document");
  if (!(documentFile instanceof File)) return Response.json({ error: "Choose a replacement Project Document." }, { status: 400 });
  let intake: Awaited<ReturnType<typeof readProjectDocument>>;
  try {
    intake = await readProjectDocument(documentFile, true);
  } catch (error) {
    if (error instanceof ProjectDocumentIntakeError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const { mediaType, text, fingerprint } = intake;

  const { documentId } = await context.params;
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const { data, error } = await client.rpc("begin_project_document_replacement", {
    p_document_id: documentId,
    p_document: {
      knowledge_base_id: KNOWLEDGE_BASE_ID,
      name: documentFile.name,
      media_type: mediaType,
      byte_size: documentFile.size,
      original_text: text,
      content_fingerprint: fingerprint,
      status: "indexing"
    }
  });
  if (error?.code === "23505" && error.message.includes("content_fingerprint")) {
    return Response.json({ error: "An identical Project Document is already in the Knowledge Base." }, { status: 409 });
  }
  if (error?.code === "23505" || error?.message.includes("DOCUMENT_REPLACEMENT_PENDING")) {
    return Response.json({ error: "This Project Document already has a pending Document Replacement." }, { status: 409 });
  }
  if (error || !data) return Response.json({ error: "This ready Project Document is not available for replacement." }, { status: 409 });

  try {
    const result = await runProjectDocumentIndexing(client, data.id, text, mediaType === "text/markdown", configuration.geminiApiKey);
    if (result.outcome === "failed") {
      return Response.json({ error: result.detail, replacement: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 502 });
    }
    invalidateReadyDocumentCountCache();
    return Response.json({ document: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 201 });
  } catch {
    return Response.json({ error: "Replacement indexing failed and cleanup could not be confirmed." }, { status: 502 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ documentId: string }> }) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to discard Document Replacements." }, { status: 401 });
  }
  try {
    const { documentId } = await context.params;
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client.rpc("discard_project_document_replacement", { p_document_id: documentId });
    if (error || !data) return Response.json({ error: "This Document Replacement is not available to discard." }, { status: 409 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }
}
