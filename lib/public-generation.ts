import "server-only";

import {
  GenerationCancelledError,
  GenerationTimeoutError,
  GenerationUnavailableError,
  requestGeneration
} from "./generation";
import { admitPublicAction } from "./public-allowance";

export function generationUnavailableResponse(format: "json" | "text" = "json") {
  const message = "Generation is temporarily unavailable. Please try again later.";
  return format === "text"
    ? new Response(message, { status: 503 })
    : Response.json({ error: message }, { status: 503 });
}

export function generationTimeoutResponse(format: "json" | "text" = "json") {
  const message = "Generation took too long. Please try again.";
  return format === "text"
    ? new Response(message, { status: 504 })
    : Response.json({ error: message }, { status: 504 });
}

/** The client has gone away; the body is never read, the status keeps logs honest. */
export function clientClosedResponse() {
  return new Response(null, { status: 499 });
}

export async function requestPublicGeneration(
  request: Request,
  operation: "generateContent" | "streamGenerateContent",
  apiKey: string,
  body: unknown,
  unavailableFormat: "json" | "text" = "json"
): Promise<{ providerResponse: Response } | { publicResponse: Response }> {
  const admission = await admitPublicAction(request);
  if (admission) return { publicResponse: admission };

  try {
    return { providerResponse: await requestGeneration(operation, apiKey, body, { signal: request.signal }) };
  } catch (error) {
    if (error instanceof GenerationUnavailableError) {
      return { publicResponse: generationUnavailableResponse(unavailableFormat) };
    }
    if (error instanceof GenerationTimeoutError) {
      return { publicResponse: generationTimeoutResponse(unavailableFormat) };
    }
    if (error instanceof GenerationCancelledError) {
      return { publicResponse: clientClosedResponse() };
    }
    throw error;
  }
}
