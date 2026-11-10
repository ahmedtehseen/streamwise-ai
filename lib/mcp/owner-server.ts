import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type AnswerFlagServiceError,
  type AnswerFlagServiceResult,
  getAnswerFlag,
  listAnswerFlagsPage,
  reviewAnswerFlag
} from "../knowledge/answer-flag-service";

function resultContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failureContent(error: AnswerFlagServiceError): CallToolResult {
  const payload = {
    ok: false,
    outcome: "error",
    error: { code: error.code, message: error.message, retryable: error.status >= 500 }
  };
  return {
    ...resultContent(payload),
    structuredContent: payload,
    isError: true
  };
}

export function createOwnerMcpServer() {
  const server = new McpServer({ name: "streamwise-owner", version: "1.0.0" });

  const calls = new Map<string, (input: unknown) => Promise<CallToolResult>>();

  function registerOwnerTool<T extends z.ZodRawShape>(
    name: string,
    configuration: {
      title: string;
      description: string;
      inputSchema: z.ZodObject<T>;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
    },
    operation: (input: z.output<z.ZodObject<T>>) => Promise<AnswerFlagServiceResult<unknown>>
  ) {
    const call = async (input: unknown): Promise<CallToolResult> => {
      const parsed = configuration.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return failureContent({
          code: "invalid_answer_flag_query", message: "Choose valid Answer Flag tool arguments.", status: 400
        });
      }
      try {
        const result = await operation(parsed.data);
        return result.ok ? resultContent(result.value) : failureContent(result.error);
      } catch {
        return failureContent({
          code: "answer_flags_unavailable", message: "Answer Flags are temporarily unavailable.", status: 502
        });
      }
    };
    calls.set(name, call);
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, configuration, async (input) => call(input));
  }

  registerOwnerTool(
    "list_answer_flags",
    {
      title: "List Answer Flags",
      description: "List a bounded page of Answer Flag summaries for Portfolio Owner review.",
      inputSchema: z.object({
        status: z.enum(["open", "reviewed"]).default("open"),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().min(1).max(2_048).optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ status, limit, cursor }) => {
      return listAnswerFlagsPage({ status, limit, ...(cursor ? { cursor } : {}) });
    }
  );

  registerOwnerTool(
    "get_answer_flag",
    {
      title: "Get Answer Flag",
      description: "Inspect the immutable response snapshot captured by one Answer Flag.",
      inputSchema: z.object({ flagId: z.string().uuid() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ flagId }) => {
      return getAnswerFlag({ flagId });
    }
  );

  registerOwnerTool(
    "review_answer_flag",
    {
      title: "Review Answer Flag",
      description: "Mark the exact Answer Flag approved by the Portfolio Owner as reviewed.",
      inputSchema: z.object({ flagId: z.string().uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ flagId }) => {
      return reviewAnswerFlag({ flagId });
    }
  );

  // Validate using the same advertised schemas so SDK validation failures use
  // the owner error contract without reflecting rejected argument values.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const call = calls.get(request.params.name);
    if (!call) {
      return failureContent({
        code: "invalid_answer_flag_query", message: "Choose a supported Answer Flag tool.", status: 400
      });
    }
    return call(request.params.arguments);
  });

  return server;
}
