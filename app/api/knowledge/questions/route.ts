import {
  createKnowledgeClient,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  embedProjectQuestion,
  generateGroundedAnswer,
  knowledgeConfiguration
} from "../../../../lib/knowledge/server";
import { z } from "zod";

export const runtime = "nodejs";

const matchedChunkSchema = z.object({
  chunk_id: z.string().min(1),
  document_name: z.string().min(1),
  text: z.string().min(1),
  heading_path: z.array(z.string()),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  cosine_distance: z.number()
});

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
  const { count, error } = await client
    .from("project_documents")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready");
  if (error) return Response.json({ error: "The Knowledge Base could not be checked." }, { status: 502 });
  if (!count) {
    return Response.json({ error: "Index at least one Project Document before asking a question." }, { status: 409 });
  }

  try {
    const question = payload.question.trim();
    const queryEmbedding = await embedProjectQuestion(question, configuration.geminiApiKey);
    const { data, error: matchError } = await client.rpc("match_ready_document_chunks", {
      p_query_embedding: queryEmbedding,
      p_match_count: 5,
      p_embedding_model: EMBEDDING_MODEL,
      p_embedding_dimension: EMBEDDING_DIMENSION
    });
    if (matchError) return Response.json({ error: "The Knowledge Base could not be searched." }, { status: 502 });
    const matchedChunks = z.array(matchedChunkSchema).parse(data);
    const evidence = matchedChunks.map((chunk, index) => ({ id: `source-${index + 1}`, text: chunk.text }));
    const answer = await generateGroundedAnswer(question, evidence, configuration.geminiApiKey);
    if (answer.outcome === "insufficient_evidence") {
      return Response.json({ outcome: "insufficient_evidence", paragraphs: [] });
    }

    const sources = new Map(matchedChunks.map((chunk, index) => [`source-${index + 1}`, chunk]));
    const paragraphs = answer.paragraphs.map((paragraph) => ({
      text: paragraph.text,
      sourceReferences: [...new Set(paragraph.chunkIds)].map((id) => {
        const chunk = sources.get(id);
        if (!chunk) throw new Error("Gemini cited a passage that was not retrieved.");
        return {
          id,
          documentName: chunk.document_name,
          headingPath: chunk.heading_path,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          excerpt: chunk.text
        };
      })
    }));
    return Response.json({ outcome: "answered", paragraphs });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "A Grounded Answer could not be generated." }, { status: 502 });
  }
}
