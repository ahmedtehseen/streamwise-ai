export const PRIMARY_GENERATION_MODEL = "gemini-3.5-flash-lite";
export const SECONDARY_GENERATION_MODEL = "gemini-3.1-flash-lite";

const SHORT_WINDOW_RETRY_BASE_MS = 100;
const SHORT_WINDOW_RETRY_JITTER_MS = 100;

/** Whole-call deadline for a non-streaming generation, including the short-window retry and model fallback. */
export const GENERATION_DEADLINE_MS = 30_000;
/** Whole-call deadline for a streaming generation, from the first request until the stream finishes. */
export const STREAM_GENERATION_DEADLINE_MS = 90_000;

export class GenerationUnavailableError extends Error {
  constructor() {
    super("Generation is temporarily unavailable. Please try again later.");
    this.name = "GenerationUnavailableError";
  }
}

export class GenerationTimeoutError extends Error {
  constructor() {
    super("Generation took too long. Please try again.");
    this.name = "GenerationTimeoutError";
  }
}

export class GenerationCancelledError extends Error {
  constructor() {
    super("Generation was cancelled.");
    this.name = "GenerationCancelledError";
  }
}

export type GenerationOptions = {
  /** Aborts the provider call when the caller goes away, e.g. `request.signal`. */
  signal?: AbortSignal;
  /** Overrides the default deadline for this operation. */
  timeoutMs?: number;
};

/**
 * Builds one signal that fires on the caller's cancellation or the deadline, and a classifier
 * that turns the resulting abort into a typed error. The same signal stays attached to a
 * streaming response body, so the deadline also bounds stream reads.
 */
export function generationSignal(timeoutMs: number, callerSignal?: AbortSignal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  return {
    signal,
    classify(error: unknown): unknown {
      if (callerSignal?.aborted) return new GenerationCancelledError();
      if (deadline.aborted) return new GenerationTimeoutError();
      return error;
    }
  };
}

/**
 * A log-safe description of a failed provider response: HTTP status plus the provider's
 * machine-readable status code. Never includes the provider's message, which can echo
 * prompt or document content.
 */
export async function providerErrorSummary(response: Response) {
  let providerStatus: string | undefined;
  try {
    const payload = await response.clone().json() as GeminiError;
    if (typeof payload.error?.status === "string" && /^[A-Z_]{1,64}$/.test(payload.error.status)) {
      providerStatus = payload.error.status;
    }
  } catch {
    // Non-JSON error bodies are intentionally not logged.
  }
  return { httpStatus: response.status, ...(providerStatus ? { providerStatus } : {}) };
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

function waitForShortWindowRetry(signal: AbortSignal) {
  const delay = SHORT_WINDOW_RETRY_BASE_MS + Math.floor(Math.random() * SHORT_WINDOW_RETRY_JITTER_MS);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Calls Gemini with a bounded deadline and optional caller cancellation.
 * Throws GenerationTimeoutError when the deadline passes and GenerationCancelledError
 * when the caller's signal aborts. For streaming calls the deadline keeps applying to
 * reads of the returned body, so callers must also classify body-read errors.
 */
export async function requestGeneration(
  operation: "generateContent" | "streamGenerateContent",
  apiKey: string,
  body: unknown,
  options: GenerationOptions = {}
) {
  const { signal, classify } = generationSignal(
    options.timeoutMs ?? (operation === "streamGenerateContent" ? STREAM_GENERATION_DEADLINE_MS : GENERATION_DEADLINE_MS),
    options.signal
  );
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal
  };

  try {
    let primary = await fetch(generationUrl(PRIMARY_GENERATION_MODEL, operation), init);
    let primaryQuotaKind = await quotaKind(primary);

    if (primaryQuotaKind === "short_window") {
      await waitForShortWindowRetry(signal);
      primary = await fetch(generationUrl(PRIMARY_GENERATION_MODEL, operation), init);
      primaryQuotaKind = await quotaKind(primary);
    }

    if (primaryQuotaKind !== "daily") return primary;

    const secondary = await fetch(generationUrl(SECONDARY_GENERATION_MODEL, operation), init);
    if (await quotaKind(secondary) === "daily") throw new GenerationUnavailableError();
    return secondary;
  } catch (error) {
    throw classify(error);
  }
}
