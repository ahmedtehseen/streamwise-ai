import "server-only";

import { chunkProjectDocument } from "./chunks";
import {
  createKnowledgeClient,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  embedProjectDocumentPassage,
  KnowledgeIndexingError
} from "./server";

type KnowledgeClient = ReturnType<typeof createKnowledgeClient>;

export type ProjectDocumentRecord = {
  id: string;
  name: string;
  media_type: string;
  byte_size: number;
  original_text?: string;
  status: "indexing" | "ready" | "failed";
  failure_detail?: string | null;
  failure_retryable?: boolean;
  created_at: string;
  updated_at: string;
};

export function publicProjectDocument(document: ProjectDocumentRecord) {
  return {
    id: document.id,
    name: document.name,
    mediaType: document.media_type,
    byteSize: document.byte_size,
    status: document.status,
    failureDetail: document.failure_detail ?? null,
    retryable: document.status === "failed" && document.failure_retryable === true,
    createdAt: document.created_at,
    updatedAt: document.updated_at
  };
}

export async function indexProjectDocument(
  client: KnowledgeClient,
  documentId: string,
  text: string,
  markdown: boolean,
  geminiApiKey: string
) {
  let chunks;
  try {
    chunks = chunkProjectDocument(text, markdown);
  } catch {
    throw new KnowledgeIndexingError("This Project Document could not be parsed. Correct its content before uploading a replacement.", false);
  }
  if (chunks.length === 0) {
    throw new KnowledgeIndexingError("This Project Document does not contain indexable text. Upload a replacement with readable content.", false);
  }

  const embeddings = await Promise.all(chunks.map((chunk) => embedProjectDocumentPassage(chunk.text, geminiApiKey)));
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
  const { data, error } = await client.rpc("complete_project_document_indexing", {
    p_document_id: documentId,
    p_chunks: completedChunks
  });
  if (error || !data) throw new KnowledgeIndexingError("The Project Document chunks could not be saved. Try again.", true);
  return data;
}

export async function exposeFailedIndexing(
  client: KnowledgeClient,
  documentId: string,
  error: unknown
) {
  const detail = error instanceof Error ? error.message : "The Project Document could not be indexed.";
  const retryable = error instanceof KnowledgeIndexingError ? error.retryable : true;
  const { data, error: failureError } = await client.rpc("fail_project_document_indexing", {
    p_document_id: documentId,
    p_failure_detail: detail,
    p_failure_retryable: retryable
  });
  if (failureError || !data) throw new Error("Indexing failed and the Project Document cleanup could not be confirmed.");
  return { detail, document: data };
}
