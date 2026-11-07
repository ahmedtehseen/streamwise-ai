import "server-only";

import { GenerationUnavailableError, requestGeneration } from "./generation";
import { admitPublicAction } from "./public-allowance";

export function generationUnavailableResponse(format: "json" | "text" = "json") {
  const message = "Generation is temporarily unavailable. Please try again later.";
  return format === "text"
    ? new Response(message, { status: 503 })
    : Response.json({ error: message }, { status: 503 });
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
    return { providerResponse: await requestGeneration(operation, apiKey, body) };
  } catch (error) {
    if (error instanceof GenerationUnavailableError) {
      return { publicResponse: generationUnavailableResponse(unavailableFormat) };
    }
    throw error;
  }
}
