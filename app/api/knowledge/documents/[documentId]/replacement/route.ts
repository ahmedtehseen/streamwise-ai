import { createHash } from "node:crypto";
import { ProjectDocumentRecord, publicProjectDocument, runProjectDocumentIndexing } from "../../../../../../lib/knowledge/indexing";
import { createKnowledgeClient, KNOWLEDGE_BASE_ID, knowledgeConfiguration, knowledgeDatabaseConfiguration, verifyAdminAccess } from "../../../../../../lib/knowledge/server";
import { extractTextFromBuffer, SupportedMediaType } from "../../../../../../lib/knowledge/extractors";
import { invalidateReadyDocumentCountCache } from "../../../questions/route";

export const runtime = "nodejs";
const MAX_DOCUMENT_BYTES = 500 * 1024;

function mediaTypeFor(file: File): SupportedMediaType | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  const unspecified = type === "" || type === "application/octet-stream";
  if ((name.endsWith(".md") || name.endsWith(".markdown")) && (unspecified || type === "text/markdown" || type === "text/plain")) return "text/markdown";
  if (name.endsWith(".txt") && (unspecified || type === "text/plain")) return "text/plain";
  if (name.endsWith(".pdf") && (unspecified || type === "application/pdf")) return "application/pdf";
  if ((name.endsWith(".html") || name.endsWith(".htm")) && (unspecified || type === "text/html")) return "text/html";
  if (name.endsWith(".json") && (unspecified || type === "application/json" || type === "text/plain")) return "application/json";
  if (name.endsWith(".csv") && (unspecified || type === "text/csv" || type === "application/vnd.ms-excel" || type === "text/plain")) return "text/csv";
  return null;
}

function looksBinary(bytes: Uint8Array) {
  if (bytes.includes(0)) return true;
  let suspicious = 0;
  for (const byte of bytes) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) suspicious += 1;
  return suspicious / bytes.length > 0.1;
}

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. An Admin Key is required to replace Project Documents." }, { status: 401 });
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
  if (documentFile.name.toLowerCase().endsWith(".docx") || documentFile.name.toLowerCase().endsWith(".doc")) {
    return Response.json({ error: "Word documents (.docx) are not supported. Please upload a PDF, Markdown, or text document." }, { status: 415 });
  }
  const mediaType = mediaTypeFor(documentFile);
  if (!mediaType) return Response.json({ error: "Use a supported Project Document (.md, .txt, .pdf, .html, .json, .csv)." }, { status: 415 });
  if (documentFile.size === 0) return Response.json({ error: "The replacement Project Document is empty." }, { status: 400 });
  if (documentFile.size > MAX_DOCUMENT_BYTES) return Response.json({ error: "Keep the replacement Project Document at or below 500 KB." }, { status: 413 });

  const bytes = new Uint8Array(await documentFile.arrayBuffer());
  if (mediaType !== "application/pdf" && looksBinary(bytes)) return Response.json({ error: "The replacement Project Document appears to contain binary content." }, { status: 415 });
  let text: string;
  try {
    text = await extractTextFromBuffer(bytes, mediaType);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The replacement Project Document could not be parsed." }, { status: 415 });
  }
  if (!text.trim()) return Response.json({ error: "The replacement Project Document is empty." }, { status: 400 });

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
      content_fingerprint: createHash("sha256").update(bytes).digest("hex"),
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
    return Response.json({ error: "Unauthorized. An Admin Key is required to discard Document Replacements." }, { status: 401 });
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
