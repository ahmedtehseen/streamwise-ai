import {
  askPortfolioAssistant,
  invalidateReadyDocumentCountCache
} from "../../../../lib/knowledge/portfolio-assistant-service";

export const runtime = "nodejs";

export { invalidateReadyDocumentCountCache };

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null) as { question?: unknown } | null;
  if (typeof payload?.question !== "string" || !payload.question.trim()) {
    return Response.json({ error: "Enter a project question." }, { status: 400 });
  }

  const result = await askPortfolioAssistant({ question: payload.question, request });
  if (result.ok) return Response.json(result.value);
  return Response.json(result.error, { status: result.status, headers: result.headers });
}
