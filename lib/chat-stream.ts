import { MAX_IMAGE_BYTES } from "./image-upload";

/** Most messages the model sees per request; older history is dropped. */
export const MAX_CHAT_MESSAGES = 20;
/** Longest single message text accepted, in characters. */
export const MAX_CHAT_MESSAGE_CHARS = 8_000;
/** Total text across the retained history, in characters. */
export const MAX_CHAT_TOTAL_CHARS = 40_000;
/** Most image attachments across the retained history. */
export const MAX_CHAT_IMAGES = 4;
/** Declared request size cap: the image budget plus room for text and multipart framing. */
export const MAX_CHAT_REQUEST_BYTES = MAX_CHAT_IMAGES * MAX_IMAGE_BYTES + 1_000_000;

/** Gemini finish reasons that mean the model ended its answer on purpose. */
export const COMPLETED_FINISH_REASONS = new Set(["STOP", "MAX_TOKENS"]);

export class IncompleteStreamError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "IncompleteStreamError";
  }
}

/**
 * Separates streamed answer text from a terminal error record. The chat stream is plain
 * text; when it fails after headers were sent, the server appends this marker followed by
 * `{"error": "..."}` and closes normally, so the browser can show a real reason instead of
 * a generic network error. The record separator never appears in model text we forward.
 */
export const STREAM_ERROR_MARKER = "\u001e";

/** Splits accumulated stream text into the visible answer and an optional terminal error. */
export function parseChatStream(raw: string): { text: string; error?: string } {
  const index = raw.indexOf(STREAM_ERROR_MARKER);
  if (index === -1) return { text: raw };
  const text = raw.slice(0, index);
  try {
    const record = JSON.parse(raw.slice(index + 1)) as { error?: unknown };
    return { text, error: typeof record.error === "string" ? record.error : "The response was interrupted." };
  } catch {
    // The record itself has not fully arrived yet, or is malformed.
    return { text, error: "The response was interrupted." };
  }
}
