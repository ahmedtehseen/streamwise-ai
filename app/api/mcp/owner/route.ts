import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyMcpOwnerAccess } from "../../../../lib/mcp/owner-auth";
import { createOwnerMcpServer } from "../../../../lib/mcp/owner-server";

export const runtime = "nodejs";

async function handleOwnerMcpRequest(request: Request) {
  if (!verifyMcpOwnerAccess(request)) {
    return Response.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "www-authenticate": "Bearer" } }
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createOwnerMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handleOwnerMcpRequest;
export const GET = handleOwnerMcpRequest;
export const DELETE = handleOwnerMcpRequest;

