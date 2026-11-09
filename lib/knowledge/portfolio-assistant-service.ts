import "server-only";

import { z } from "zod";
import { GenerationUnavailableError } from "../generation";
import { admitPublicAction } from "../public-allowance";
import { issueAnswerResponseIdentity } from "./answer-flags";
import {
  createKnowledgeClient,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  embedProjectQuestion,
  extractSearchKeywords,
  generateGroundedAnswer,
  KNOWLEDGE_DISTANCE_THRESHOLD,
  KnowledgeError,
  knowledgeConfiguration
} from "./server";

const matchedChunkSchema = z.object({
  chunk_id: z.string().min(1),
  document_name: z.string().min(1),
  text: z.string().min(1),
  heading_path: z.array(z.string()),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  cosine_distance: z.number(),
  fts_rank: z.number().optional().default(0),
  rrf_score: z.number().optional().default(0)
});

export type PortfolioSourceReference = {
  id: string;
  documentName: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  excerpt: string;
};

export type PortfolioAnswer = {
  outcome: "answered" | "insufficient_evidence";
  paragraphs: Array<{ text: string; sourceReferences: PortfolioSourceReference[] }>;
  degradedSearch?: boolean;
  responseId: string;
  respondedAt: string;
};

export type PortfolioAssistantFailure = {
  error: string;
  code?: string;
  retryable?: boolean;
  limitedBy?: "visitor_minute" | "global_minute" | "visitor_day" | "global_day";
  resetAt?: string;
};

export type PortfolioAssistantResult =
  | { ok: true; value: PortfolioAnswer }
  | { ok: false; error: PortfolioAssistantFailure; status: number; headers?: Record<string, string> };

let cachedReadyDocumentCount: { count: number; timestamp: number } | null = null;
const COUNT_CACHE_TTL_MS = 60_000;

export function invalidateReadyDocumentCountCache() {
  cachedReadyDocumentCount = null;
}

function failure(error: string, code: string, retryable: boolean, status: number): PortfolioAssistantResult {
  return { ok: false, error: { error, code, retryable }, status };
}

function flaggableAnswer(
  question: string,
  response: Omit<PortfolioAnswer, "responseId" | "respondedAt">
): PortfolioAssistantResult {
  return { ok: true, value: { ...response, ...issueAnswerResponseIdentity(question, response) } };
}

export async function askPortfolioAssistant(input: {
  question: string;
  request: Request;
}): Promise<PortfolioAssistantResult> {
  const allowanceResponse = await admitPublicAction(input.request);
  if (allowanceResponse) {
    const error = await allowanceResponse.json() as PortfolioAssistantFailure;
    const retryAfter = allowanceResponse.headers.get("Retry-After");
    return {
      ok: false,
      error,
      status: allowanceResponse.status,
      ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {})
    };
  }

  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return {
      ok: false,
      error: { error: error instanceof Error ? error.message : "Knowledge mode is not configured." },
      status: 500
    };
  }

  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  let count: number | null = null;
  let countError: unknown = null;
  const now = Date.now();

  if (process.env.NODE_ENV !== "test" && cachedReadyDocumentCount && now - cachedReadyDocumentCount.timestamp < COUNT_CACHE_TTL_MS) {
    count = cachedReadyDocumentCount.count;
  } else {
    const countResponse = await client
      .from("project_documents")
      .select("*", { count: "exact", head: true })
      .eq("status", "ready");
    count = countResponse.count;
    countError = countResponse.error;
    if (!countError && typeof count === "number" && count > 0) {
      cachedReadyDocumentCount = { count, timestamp: now };
    } else {
      cachedReadyDocumentCount = null;
    }
  }

  if (countError) return failure("The Knowledge Base could not be checked.", "database_unavailable", true, 503);
  if (!count) {
    return {
      ok: false,
      error: { error: "Index at least one Project Document before asking a question." },
      status: 409
    };
  }

  try {
    const question = input.question.trim();
    const searchKeywords = extractSearchKeywords(question);
    let degradedSearch = false;
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embedProjectQuestion(question, configuration.geminiApiKey);
    } catch (error) {
      if (!(error instanceof KnowledgeError) || !error.retryable) throw error;
      degradedSearch = true;
    }

    let rpcResult;
    if (degradedSearch) {
      rpcResult = await client.rpc("match_ready_document_chunks_full_text", {
        p_query_text: searchKeywords,
        p_match_count: 5
      });
    } else {
      rpcResult = await client.rpc("match_ready_document_chunks_hybrid", {
        p_query_embedding: queryEmbedding!,
        p_query_text: searchKeywords,
        p_match_count: 5,
        p_embedding_model: EMBEDDING_MODEL,
        p_embedding_dimension: EMBEDDING_DIMENSION
      });
    }

    if (!degradedSearch && rpcResult.error && (rpcResult.error.message?.includes("function") || rpcResult.error.code === "PGRST202")) {
      rpcResult = await client.rpc("match_ready_document_chunks", {
        p_query_embedding: queryEmbedding,
        p_match_count: 5,
        p_embedding_model: EMBEDDING_MODEL,
        p_embedding_dimension: EMBEDDING_DIMENSION
      });
    }

    const { data, error: matchError } = rpcResult;
    if (matchError) return failure("The Knowledge Base could not be searched.", "retrieval_unavailable", true, 503);
    const matchedChunks = z.array(matchedChunkSchema).parse(data);
    const relevantChunks = matchedChunks.filter(
      (chunk) => (!degradedSearch && chunk.cosine_distance <= KNOWLEDGE_DISTANCE_THRESHOLD) || (chunk.fts_rank && chunk.fts_rank > 0)
    );
    if (relevantChunks.length === 0) {
      return flaggableAnswer(question, {
        outcome: "insufficient_evidence",
        paragraphs: [],
        ...(degradedSearch ? { degradedSearch: true } : {})
      });
    }

    const selectedChunks = relevantChunks.slice(0, 5);
    const evidence = selectedChunks.map((chunk, index) => ({ id: `source-${index + 1}`, text: chunk.text }));
    const answer = await generateGroundedAnswer(question, evidence, configuration.geminiApiKey);
    if (answer.outcome === "insufficient_evidence") {
      return flaggableAnswer(question, {
        outcome: "insufficient_evidence",
        paragraphs: [],
        ...(degradedSearch ? { degradedSearch: true } : {})
      });
    }

    const sources = new Map(selectedChunks.map((chunk, index) => [`source-${index + 1}`, chunk]));
    const paragraphs = answer.paragraphs.map((paragraph) => {
      if (paragraph.chunkIds.length === 0) {
        throw new KnowledgeError(
          "Gemini returned a Grounded Answer without a Source Reference for every paragraph.",
          "invalid_model_output",
          false,
          502
        );
      }
      return {
        text: paragraph.text,
        sourceReferences: [...new Set(paragraph.chunkIds)].map((id) => {
          const chunk = sources.get(id);
          if (!chunk) {
            throw new KnowledgeError("Gemini cited a passage that was not retrieved.", "invalid_model_output", false, 502);
          }
          return {
            id,
            documentName: chunk.document_name,
            headingPath: chunk.heading_path,
            startLine: chunk.start_line,
            endLine: chunk.end_line,
            excerpt: chunk.text
          };
        })
      };
    });
    return flaggableAnswer(question, {
      outcome: "answered",
      paragraphs,
      ...(degradedSearch ? { degradedSearch: true } : {})
    });
  } catch (error) {
    if (error instanceof GenerationUnavailableError) {
      return failure(error.message, "generation_unavailable", true, 503);
    }
    if (error instanceof KnowledgeError) {
      return failure(error.message, error.code, error.retryable, error.status);
    }
    return {
      ok: false,
      error: { error: error instanceof Error ? error.message : "A Grounded Answer could not be generated." },
      status: 502
    };
  }
}
