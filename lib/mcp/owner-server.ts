import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAnswerFlag,
  listAnswerFlagsPage,
  reviewAnswerFlag
} from "../knowledge/answer-flag-service";

function resultContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failureContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const
  };
}

export function createOwnerMcpServer() {
  const server = new McpServer({ name: "streamwise-owner", version: "1.0.0" });

  server.registerTool(
    "list_answer_flags",
    {
      title: "List Answer Flags",
      description: "List a bounded page of Answer Flag summaries for Portfolio Owner review.",
      inputSchema: {
        status: z.enum(["open", "reviewed"]).default("open"),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().min(1).max(2_048).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ status, limit, cursor }) => {
      const result = await listAnswerFlagsPage({ status, limit, ...(cursor ? { cursor } : {}) });
      return result.ok ? resultContent(result.value) : failureContent(result.error.message);
    }
  );

  server.registerTool(
    "get_answer_flag",
    {
      title: "Get Answer Flag",
      description: "Inspect the immutable response snapshot captured by one Answer Flag.",
      inputSchema: { flagId: z.string().uuid() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ flagId }) => {
      const result = await getAnswerFlag({ flagId });
      return result.ok ? resultContent(result.value) : failureContent(result.error.message);
    }
  );

  server.registerTool(
    "review_answer_flag",
    {
      title: "Review Answer Flag",
      description: "Mark the exact Answer Flag approved by the Portfolio Owner as reviewed.",
      inputSchema: { flagId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ flagId }) => {
      const result = await reviewAnswerFlag({ flagId });
      return result.ok ? resultContent(result.value) : failureContent(result.error.message);
    }
  );

  return server;
}
