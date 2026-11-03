import { createHash } from "node:crypto";
import { chunkProjectDocument } from "../../../../lib/knowledge/chunks";
import {
  createKnowledgeClient,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  embedProjectDocumentPassage,
  KNOWLEDGE_BASE_ID,
  knowledgeDatabaseConfiguration,
  knowledgeConfiguration
} from "../../../../lib/knowledge/server";

export const runtime = "nodejs";
const MAX_DOCUMENT_BYTES = 500 * 1024;

type DocumentRecord = {
  id: string;
  name: string;
  media_type: string;
  byte_size: number;
  status: "indexing" | "ready" | "failed";
  failure_detail?: string | null;
  created_at: string;
  updated_at: string;
};

function publicDocument(document: DocumentRecord) {
  return {
    id: document.id,
    name: document.name,
    mediaType: document.media_type,
    byteSize: document.byte_size,
    status: document.status,
    failureDetail: document.failure_detail ?? null,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  };
}

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
      .select("id,name,media_type,byte_size,status,failure_detail,created_at,updated_at")
      .order("created_at", { ascending: false });
    if (error) return Response.json({ error: "The Knowledge Base could not be loaded." }, { status: 502 });
    return Response.json({ documents: (data as DocumentRecord[]).map(publicDocument) });
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
  const chunks = chunkProjectDocument(text, mediaType === "text/markdown");
  if (chunks.length === 0) return Response.json({ error: "The Project Document does not contain indexable text." }, { status: 400 });

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
    .select("id,name,media_type,byte_size,status,failure_detail,created_at,updated_at")
    .single();
  if (insertError || !indexingDocument) return Response.json({ error: "The Project Document could not be saved for indexing." }, { status: 502 });

  try {
    const embeddings = await Promise.all(chunks.map((chunk) => embedProjectDocumentPassage(chunk.text, configuration.geminiApiKey)));
    const completedChunks = chunks.map((chunk, ordinal) => ({
      ordinal,
      text: chunk.text,
      heading_path: chunk.headingPath,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      embedding_model: EMBEDDING_MODEL,
      embedding_dimension: EMBEDDING_DIMENSION,
      embedding: embeddings[ordinal]
    }));
    const { data: readyDocument, error: completionError } = await client.rpc("complete_project_document_indexing", {
      p_document_id: indexingDocument.id,
      p_chunks: completedChunks
    });
    if (completionError || !readyDocument) throw new Error("The Project Document chunks could not be saved.");
    return Response.json({ document: publicDocument(readyDocument as DocumentRecord) }, { status: 201 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The Project Document could not be indexed.";
    await client.from("project_documents").update({ status: "failed", failure_detail: detail }).eq("id", indexingDocument.id);
    return Response.json({ error: detail }, { status: 502 });
  }
}
