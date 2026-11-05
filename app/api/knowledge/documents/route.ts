import { ProjectDocumentRecord, publicProjectDocument, runProjectDocumentIndexing } from "../../../../lib/knowledge/indexing";
import { ProjectDocumentIntakeError, readProjectDocument } from "../../../../lib/knowledge/document-intake";
import {
  createKnowledgeClient,
  KNOWLEDGE_BASE_ID,
  knowledgeDatabaseConfiguration,
  knowledgeConfiguration,
  verifyAdminAccess
} from "../../../../lib/knowledge/server";
import { invalidateReadyDocumentCountCache } from "../questions/route";

export const runtime = "nodejs";

export async function GET() {
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("project_documents")
      .select("id,name,media_type,byte_size,status,failure_detail,failure_retryable,replaces_document_id,created_at,updated_at")
      .order("created_at", { ascending: false });
    if (error) return Response.json({ error: "The Knowledge Base could not be loaded." }, { status: 502 });
    const records = data as ProjectDocumentRecord[];
    const replacements = new Map(records
      .filter((document) => document.replaces_document_id)
      .map((document) => [document.replaces_document_id as string, publicProjectDocument(document)]));
    return Response.json({
      documents: records
        .filter((document) => !document.replaces_document_id)
        .map((document) => {
          const replacement = replacements.get(document.id);
          return replacement ? { ...publicProjectDocument(document), replacement } : publicProjectDocument(document);
        })
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to upload Project Documents." }, { status: 401 });
  }

  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }

  const formData = await request.formData().catch(() => null);
  const documentFile = formData?.get("document");
  if (!(documentFile instanceof File)) return Response.json({ error: "Choose a Project Document to upload." }, { status: 400 });

  let intake: Awaited<ReturnType<typeof readProjectDocument>>;
  try {
    intake = await readProjectDocument(documentFile);
  } catch (error) {
    if (error instanceof ProjectDocumentIntakeError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const { mediaType, text, fingerprint } = intake;
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const { data: indexingDocument, error: insertError } = await client.rpc("begin_project_document_indexing", {
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
  if (insertError) {
    console.error("Document indexing insert error:", insertError);
  }
  if (insertError?.message.includes("KNOWLEDGE_BASE_CAPACITY")) {
    return Response.json({ error: "The Knowledge Base can contain at most 20 Project Documents." }, { status: 409 });
  }
  if (insertError?.code === "23505") {
    return Response.json({ error: "An identical Project Document is already in the Knowledge Base." }, { status: 409 });
  }
  if (insertError || !indexingDocument) {
    return Response.json({ 
      error: insertError?.message?.includes("project_documents_media_type_check")
        ? `Database constraint error: '${mediaType}' is not yet allowed in Supabase. Please apply migration 202611040001_multi_format_and_hybrid_search.sql.`
        : "The Project Document could not be saved for indexing."
    }, { status: 502 });
  }

  try {
    const result = await runProjectDocumentIndexing(client, indexingDocument.id, text, mediaType === "text/markdown", configuration.geminiApiKey);
    if (result.outcome === "failed") {
      return Response.json({ error: result.detail, document: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 502 });
    }
    invalidateReadyDocumentCountCache();
    return Response.json({ document: publicProjectDocument(result.document as ProjectDocumentRecord) }, { status: 201 });
  } catch {
    return Response.json({ error: "Indexing failed and the Project Document cleanup could not be confirmed." }, { status: 502 });
  }
}
