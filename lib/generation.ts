export const PRIMARY_GENERATION_MODEL = "gemini-3.5-flash-lite";
export const SECONDARY_GENERATION_MODEL = "gemini-3.1-flash-lite";

const SHORT_WINDOW_RETRY_BASE_MS = 100;
const SHORT_WINDOW_RETRY_JITTER_MS = 100;

export class GenerationUnavailableError extends Error {
  constructor() {
    super("Generation is temporarily unavailable. Please try again later.");
    this.name = "GenerationUnavailableError";
  }
}

type GeminiError = {
  error?: {
    status?: unknown;
    details?: unknown;
  };
};

async function quotaKind(response: Response): Promise<"daily" | "short_window" | null> {
  if (response.status !== 429) return null;

  let payload: GeminiError;
  try {
    payload = await response.clone().json() as GeminiError;
  } catch {
    return null;
  }

  if (payload.error?.status !== "RESOURCE_EXHAUSTED") return null;
  const details = JSON.stringify(payload.error.details ?? []);
  if (/per.?day|daily/i.test(details)) return "daily";
  return "short_window";
}

function generationUrl(model: string, operation: "generateContent" | "streamGenerateContent") {
  const query = operation === "streamGenerateContent" ? "?alt=sse" : "";
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${operation}${query}`;
}

function waitForShortWindowRetry() {
  const delay = SHORT_WINDOW_RETRY_BASE_MS + Math.floor(Math.random() * SHORT_WINDOW_RETRY_JITTER_MS);
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}

export async function requestGeneration(
  operation: "generateContent" | "streamGenerateContent",
  apiKey: string,
  body: unknown
) {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body)
  };

  let primary = await fetch(generationUrl(PRIMARY_GENERATION_MODEL, operation), init);
  let primaryQuotaKind = await quotaKind(primary);

  if (primaryQuotaKind === "short_window") {
    await waitForShortWindowRetry();
    primary = await fetch(generationUrl(PRIMARY_GENERATION_MODEL, operation), init);
    primaryQuotaKind = await quotaKind(primary);
  }

  if (primaryQuotaKind !== "daily") return primary;

  const secondary = await fetch(generationUrl(SECONDARY_GENERATION_MODEL, operation), init);
  if (await quotaKind(secondary) === "daily") throw new GenerationUnavailableError();
  return secondary;
}
