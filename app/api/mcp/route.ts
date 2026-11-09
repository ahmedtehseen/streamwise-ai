import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  askPortfolioAssistant,
  type PortfolioAssistantFailure
} from "../../../lib/knowledge/portfolio-assistant-service";

export const runtime = "nodejs";

const askPortfolioInput = z.object({
  question: z.string().trim().min(1).max(500)
}).strict();

const safeFailureMessages: Record<string, string> = {
  allowance_unavailable: "Public usage allowance is temporarily unavailable. Please try again later.",
  database_unavailable: "The Knowledge Base is temporarily unavailable.",
  generation_unavailable: "The Portfolio Assistant is temporarily unavailable.",
  invalid_model_output: "The Portfolio Assistant could not produce a valid Grounded Answer.",
  knowledge_base_empty: "The Knowledge Base has no ready Project Documents.",
  retrieval_unavailable: "The Knowledge Base is temporarily unavailable.",
  visitor_identity_unavailable: "Streamwise could not verify the Visitor identity required for public access."
};

function safeMcpFailure(error: PortfolioAssistantFailure, status: number) {
  const code = error.code ?? (status === 409 ? "knowledge_base_empty" : "portfolio_unavailable");
  const message = code === "public_allowance_limited"
    ? error.error
    : safeFailureMessages[code] ?? "The Portfolio Assistant is temporarily unavailable.";

  return {
    ok: false as const,
    outcome: "error" as const,
    error: {
      code,
      message,
      retryable: error.retryable ?? status >= 500,
      ...(error.limitedBy ? { limitedBy: error.limitedBy } : {}),
      ...(error.resetAt ? { resetAt: error.resetAt } : {})
    }
  };
}

function createServer(request: Request) {
  const server = new McpServer({ name: "streamwise-public", version: "1.0.0" });

  server.registerTool("ask_portfolio", {
    title: "Ask the Portfolio Assistant",
    description: "Ask one bounded question about the Portfolio Owner and receive a source-backed answer.",
    inputSchema: askPortfolioInput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false
    }
  }, async ({ question }) => {
    const result = await askPortfolioAssistant({ question, request });
    const payload = result.ok
      ? { ok: true, ...result.value }
      : safeMcpFailure(result.error, result.status);

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(!result.ok ? { isError: true } : {})
    };
  });

  return server;
}

async function handle(request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createServer(request);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
