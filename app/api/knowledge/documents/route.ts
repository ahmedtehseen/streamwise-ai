import { createHash } from "node:crypto";
import {
  exposeFailedIndexing,
  indexProjectDocument,
  ProjectDocumentRecord,
  publicProjectDocument
} from "../../../../lib/knowledge/indexing";
import {
  createKnowledgeClient,
  KNOWLEDGE_BASE_ID,
  knowledgeDatabaseConfiguration,
  knowledgeConfiguration
} from "../../../../lib/knowledge/server";

export const runtime = "nodejs";
const MAX_DOCUMENT_BYTES = 500 * 1024;

function mediaTypeFor(file: File) {
  const lowerName = file.name.toLowerCase();
  if (file.type === "text/markdown" || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "text/markdown";
  if (file.type === "text/plain" || lowerName.endsWith(".txt")) return "text/plain";
  return null;
}

export async function GET() {
  try {
    const configuration = knowledgeDatabaseConfiguration();
    const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
    const { data, error } = await client
      .from("project_documents")
      .select("id,name,media_type,byte_size,status,failure_detail,failure_retryable,created_at,updated_at")
      .order("created_at", { ascending: false });
    if (error) return Response.json({ error: "The Knowledge Base could not be loaded." }, { status: 502 });
    return Response.json({ documents: (data as ProjectDocumentRecord[]).map(publicProjectDocument) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }

  const formData = await request.formData().catch(() => null);
  const documentFile = formData?.get("document");
  if (!(documentFile instanceof File)) return Response.json({ error: "Choose a Markdown or plain-text Project Document." }, { status: 400 });
  const mediaType = mediaTypeFor(documentFile);
  if (!mediaType) return Response.json({ error: "Use a Markdown (.md) or plain-text (.txt) Project Document." }, { status: 415 });
  if (documentFile.size === 0) return Response.json({ error: "The Project Document is empty." }, { status: 400 });
  if (documentFile.size > MAX_DOCUMENT_BYTES) return Response.json({ error: "Keep the Project Document at or below 500 KB." }, { status: 413 });

  const bytes = new Uint8Array(await documentFile.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return Response.json({ error: "The Project Document must contain valid UTF-8 text." }, { status: 415 });
  }
  if (!text.trim()) return Response.json({ error: "The Project Document is empty." }, { status: 400 });
  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const { data: indexingDocument, error: insertError } = await client
    .from("project_documents")
    .insert({
      knowledge_base_id: KNOWLEDGE_BASE_ID,
      name: documentFile.name,
      media_type: mediaType,
      byte_size: documentFile.size,
      original_text: text,
      content_fingerprint: fingerprint,
      status: "indexing"
    })
    .select("id,name,media_type,byte_size,status,failure_detail,failure_retryable,created_at,updated_at")
    .single();
  if (insertError || !indexingDocument) return Response.json({ error: "The Project Document could not be saved for indexing." }, { status: 502 });

  try {
    const readyDocument = await indexProjectDocument(client, indexingDocument.id, text, mediaType === "text/markdown", configuration.geminiApiKey);
    return Response.json({ document: publicProjectDocument(readyDocument as ProjectDocumentRecord) }, { status: 201 });
  } catch (error) {
    try {
      const failed = await exposeFailedIndexing(client, indexingDocument.id, error);
      return Response.json({ error: failed.detail, document: publicProjectDocument(failed.document as ProjectDocumentRecord) }, { status: 502 });
    } catch {
      return Response.json({ error: "Indexing failed and the Project Document cleanup could not be confirmed." }, { status: 502 });
    }
  }
}
