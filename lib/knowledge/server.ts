import "server-only";

import { createClient } from "@supabase/supabase-js";

export const KNOWLEDGE_BASE_ID = "00000000-0000-0000-0000-000000000001";
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSION = 768;

export class KnowledgeIndexingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "KnowledgeIndexingError";
  }
}

export function knowledgeDatabaseConfiguration() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Knowledge mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  }
  return { supabaseUrl, serviceRoleKey };
}

export function knowledgeConfiguration() {
  const database = knowledgeDatabaseConfiguration();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) throw new Error("Knowledge indexing requires GEMINI_API_KEY in .env.local.");
  return { ...database, geminiApiKey };
}

export function createKnowledgeClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

export async function embedProjectDocumentPassage(text: string, apiKey: string) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      content: { parts: [{ text: `Document: ${text}` }] },
      output_dimensionality: EMBEDDING_DIMENSION
    })
  });
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new KnowledgeIndexingError(
      retryable
        ? "Gemini is temporarily unable to embed this Project Document. Try again."
        : "Gemini rejected this Project Document. Check the Gemini configuration before trying again.",
      retryable
    );
  }
  const payload = await response.json() as { embedding?: { values?: number[] } };
  const embedding = payload.embedding?.values;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSION || embedding.some((value) => !Number.isFinite(value))) {
    throw new KnowledgeIndexingError("Gemini returned an invalid Project Document embedding. Retry is unavailable until the provider response is corrected.", false);
  }
  return embedding;
}
