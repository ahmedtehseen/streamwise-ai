import "server-only";

import { extractText, getDocumentProxy } from "unpdf";

export type SupportedMediaType =
  | "text/markdown"
  | "text/plain"
  | "application/pdf"
  | "text/html"
  | "application/json"
  | "text/csv";

export const SUPPORTED_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".html",
  ".htm",
  ".json",
  ".csv"
] as const;

export function mediaTypeForFileName(fileName: string): SupportedMediaType | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return null;
}

export function stripHtmlToText(html: string): string {
  // Remove script and style elements with their contents
  let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Replace block elements with newlines
  clean = clean.replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, "\n");
  clean = clean.replace(/<br\s*\/?>/gi, "\n");
  // Strip all other HTML tags
  clean = clean.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  clean = clean
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
  // Normalize whitespace
  return clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function formatJsonToText(rawJson: string): string {
  const parsed = JSON.parse(rawJson);
  if (typeof parsed !== "object" || parsed === null) {
    return String(parsed);
  }
  // Pretty print with indent so chunker preserves structure
  return JSON.stringify(parsed, null, 2);
}

export function formatCsvToText(csv: string): string {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  const header = lines[0].split(",").map((h) => h.trim().replace(/^["']|["']$/g, ""));
  if (lines.length === 1) return `Header: ${header.join(", ")}`;

  // Convert CSV rows into contextual text lines (e.g. "Column1: val1 | Column2: val2")
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""));
    return header.map((h, i) => `${h}: ${values[i] ?? ""}`).join(" | ");
  }).join("\n");
}

export async function extractTextFromBuffer(
  bytes: Uint8Array,
  mediaType: SupportedMediaType
): Promise<string> {
  if (mediaType === "application/pdf") {
    try {
      // Pass a detached-safe copy because unpdf/pdfjs transfers the underlying ArrayBuffer
      const pdf = await getDocumentProxy(bytes.slice());
      const { text } = await extractText(pdf, { mergePages: true });
      return (text ?? "").trim();
    } catch (error) {
      throw new Error("The PDF document could not be read or is corrupted.");
    }
  }

  // Text-based formats
  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error("The document must contain valid UTF-8 text.");
  }

  if (mediaType === "text/html") {
    return stripHtmlToText(rawText);
  }

  if (mediaType === "application/json") {
    try {
      return formatJsonToText(rawText);
    } catch {
      throw new Error("The JSON document is malformed or invalid.");
    }
  }

  if (mediaType === "text/csv") {
    return formatCsvToText(rawText);
  }

  return rawText;
}

