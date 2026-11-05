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
} from "../../../../lib/knowledge/server";
import { z } from "zod";
import { admitPublicAction } from "../../../../lib/public-allowance";

export const runtime = "nodejs";

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

function failure(error: string, code: string, retryable: boolean, status: number) {
  return Response.json({ error, code, retryable }, { status });
}

let cachedReadyDocumentCount: { count: number; timestamp: number } | null = null;
const COUNT_CACHE_TTL_MS = 60_000;

export function invalidateReadyDocumentCountCache() {
  cachedReadyDocumentCount = null;
}

export async function POST(request: Request) {
  let configuration: ReturnType<typeof knowledgeConfiguration>;
  try {
    configuration = knowledgeConfiguration();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Knowledge mode is not configured." }, { status: 500 });
  }

  const payload = await request.json().catch(() => null) as { question?: unknown } | null;
  if (typeof payload?.question !== "string" || !payload.question.trim()) {
    return Response.json({ error: "Enter a project question." }, { status: 400 });
  }

  const client = createKnowledgeClient(configuration.supabaseUrl, configuration.serviceRoleKey);
  
  let count: number | null = null;
  let error: unknown = null;
  const now = Date.now();

  if (process.env.NODE_ENV !== "test" && cachedReadyDocumentCount && (now - cachedReadyDocumentCount.timestamp) < COUNT_CACHE_TTL_MS) {
    count = cachedReadyDocumentCount.count;
  } else {
    const countResponse = await client
      .from("project_documents")
      .select("*", { count: "exact", head: true })
      .eq("status", "ready");
    count = countResponse.count;
    error = countResponse.error;
    if (!error && typeof count === "number" && count > 0) {
      cachedReadyDocumentCount = { count, timestamp: now };
    } else {
      cachedReadyDocumentCount = null;
    }
  }

  if (error) return failure("The Knowledge Base could not be checked.", "database_unavailable", true, 503);
  if (!count) {
    return Response.json({ error: "Index at least one Project Document before asking a question." }, { status: 409 });
  }

  const allowanceResponse = await admitPublicAction(request);
  if (allowanceResponse) return allowanceResponse;

  try {
    const question = payload.question.trim();
    const searchKeywords = extractSearchKeywords(question);
    const queryEmbedding = await embedProjectQuestion(question, configuration.geminiApiKey);

    let rpcResult = await client.rpc("match_ready_document_chunks_hybrid", {
      p_query_embedding: queryEmbedding,
      p_query_text: searchKeywords,
      p_match_count: 5,
      p_embedding_model: EMBEDDING_MODEL,
      p_embedding_dimension: EMBEDDING_DIMENSION
    });

    if (rpcResult.error && (rpcResult.error.message?.includes("function") || rpcResult.error.code === "PGRST202")) {
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
      (chunk) => chunk.cosine_distance <= KNOWLEDGE_DISTANCE_THRESHOLD || (chunk.fts_rank && chunk.fts_rank > 0)
    );
    if (relevantChunks.length === 0) {
      return Response.json({ outcome: "insufficient_evidence", paragraphs: [] });
    }

    // Pass top 3 most relevant passages to optimize prompt processing and generation latency
    const selectedChunks = relevantChunks.slice(0, 3);
    const evidence = selectedChunks.map((chunk, index) => ({ id: `source-${index + 1}`, text: chunk.text }));
    const answer = await generateGroundedAnswer(question, evidence, configuration.geminiApiKey);
    if (answer.outcome === "insufficient_evidence") {
      return Response.json({ outcome: "insufficient_evidence", paragraphs: [] });
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
    return Response.json({ outcome: "answered", paragraphs });
  } catch (error) {
    if (error instanceof KnowledgeError) {
      return failure(error.message, error.code, error.retryable, error.status);
    }
    return Response.json({ error: error instanceof Error ? error.message : "A Grounded Answer could not be generated." }, { status: 502 });
  }
}
