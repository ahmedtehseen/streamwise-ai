import "server-only";

import { createHash } from "node:crypto";
import { extractTextFromBuffer, type SupportedMediaType } from "./extractors";

const MAX_DOCUMENT_BYTES = 500 * 1024;

export class ProjectDocumentIntakeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProjectDocumentIntakeError";
  }
}

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

export async function readProjectDocument(file: File, replacement = false) {
  const label = replacement ? "replacement Project Document" : "Project Document";
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) {
    throw new ProjectDocumentIntakeError("Word documents (.docx) are not supported. Please upload a PDF, Markdown, or text document.", 415);
  }

  const mediaType = mediaTypeFor(file);
  if (!mediaType) throw new ProjectDocumentIntakeError("Use a supported Project Document (.md, .txt, .pdf, .html, .json, .csv).", 415);
  if (file.size === 0) throw new ProjectDocumentIntakeError(`The ${label} is empty.`, 400);
  if (file.size > MAX_DOCUMENT_BYTES) throw new ProjectDocumentIntakeError(`Keep the ${label} at or below 500 KB.`, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mediaType !== "application/pdf" && looksBinary(bytes)) {
    throw new ProjectDocumentIntakeError(`The ${label} appears to contain binary content.`, 415);
  }

  let text: string;
  try {
    text = await extractTextFromBuffer(bytes, mediaType);
  } catch (error) {
    throw new ProjectDocumentIntakeError(
      error instanceof Error ? error.message : `The ${label} could not be parsed.`,
      415
    );
  }
  if (!text.trim()) throw new ProjectDocumentIntakeError(`The ${label} is empty.`, 400);

  return {
    mediaType,
    text,
    fingerprint: createHash("sha256").update(bytes).digest("hex")
  };
}
