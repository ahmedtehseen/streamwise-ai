import { generationUnavailableResponse, requestPublicGeneration } from "../../../lib/public-generation";
import { hasValidImageSignature, isSupportedImageType, MAX_IMAGE_BYTES } from "../../../lib/image-upload";
import {
  COMPLETED_FINISH_REASONS,
  IncompleteStreamError,
  MAX_CHAT_IMAGES,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_REQUEST_BYTES,
  MAX_CHAT_TOTAL_CHARS,
  STREAM_ERROR_MARKER
} from "../../../lib/chat-stream";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_REQUEST_BYTES) {
    return new Response("The chat request is too large. Remove an image or start a new conversation.", { status: 413 });
  }

  const isUpload = request.headers.get("content-type")?.includes("multipart/form-data");
  const formData = isUpload ? await request.formData().catch(() => null) : null;
  let body;
  try {
    body = isUpload ? JSON.parse(String(formData?.get("messages"))) : await request.json();
  } catch {
    return new Response("The chat request could not be read.", { status: 400 });
  }
  const messages = isUpload ? body : body?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("Please provide at least one message.", { status: 400 });
  }

  type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
  const contents: { role: "user" | "model"; parts: Part[] }[] = [];
  const recent = messages.slice(-MAX_CHAT_MESSAGES);
  const latest = recent.at(-1);
  if (typeof latest?.content === "string" && latest.content.trim().length > MAX_CHAT_MESSAGE_CHARS) {
    return new Response(`Keep each message under ${MAX_CHAT_MESSAGE_CHARS.toLocaleString("en-US")} characters.`, { status: 413 });
  }

  // Keep the newest history that fits the text and image budgets; older turns are dropped,
  // the same way history beyond MAX_CHAT_MESSAGES already is.
  let windowStart = recent.length;
  let windowChars = 0;
  let windowImages = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const candidate = recent[index];
    const chars = typeof candidate?.content === "string" ? candidate.content.trim().length : 0;
    const images = candidate?.image !== undefined ? 1 : 0;
    if (windowChars + chars > MAX_CHAT_TOTAL_CHARS || windowImages + images > MAX_CHAT_IMAGES) break;
    windowChars += chars;
    windowImages += images;
    windowStart = index;
  }

  for (const message of recent.slice(windowStart)) {
    if ((message?.role !== "user" && message?.role !== "assistant") || typeof message.content !== "string") continue;
    const parts: Part[] = [];
    const text = message.content.trim();
    if (text) parts.push({ text });
    if (message.image !== undefined) {
      if (message.role !== "user" || typeof message.image !== "string") {
        return new Response("The image attachment is invalid.", { status: 400 });
      }
      const image = formData?.get(message.image);
      if (!(image instanceof File) || image.size === 0) return new Response("Choose an image to analyze.", { status: 400 });
      if (!isSupportedImageType(image.type)) return new Response("Use a PNG, JPEG, or WebP image.", { status: 415 });
      if (image.size > MAX_IMAGE_BYTES) return new Response("Keep the image under 5 MB.", { status: 413 });
      const bytes = new Uint8Array(await image.arrayBuffer());
      if (!hasValidImageSignature(bytes, image.type)) {
        return new Response("The file contents do not match the selected image format.", { status: 415 });
      }
      parts.push({ inlineData: { mimeType: image.type, data: Buffer.from(bytes).toString("base64") } });
    }
    if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }

  if (contents.length === 0) {
    return new Response("Please provide a valid message.", { status: 400 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response("Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server.", {
      status: 500
    });
  }

  const generation = await requestPublicGeneration(request, "streamGenerateContent", process.env.GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: "You are a concise, helpful assistant." }] },
      contents
    }, "text");
  if ("publicResponse" in generation) return generation.publicResponse;
  const geminiResponse = generation.providerResponse;

  if (!geminiResponse.ok || !geminiResponse.body) {
    return generationUnavailableResponse("text");
  }

  const upstreamReader = geminiResponse.body.getReader();
  const upstreamDecoder = new TextDecoder();
  let buffer = "";
  let finishReason: string | undefined;
  let emittedText = false;
  let responseCancelled = false;

  function readSseEvent(line: string) {
    if (!line.startsWith("data: ")) return "";

    let payload;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      return "";
    }
    if (payload?.error) throw new IncompleteStreamError("The model stream reported an error.");
    const candidate = payload?.candidates?.[0];
    if (typeof candidate?.finishReason === "string") finishReason = candidate.finishReason;
    return candidate?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("") ?? "";
  }

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, text: string) {
    text = text.replaceAll(STREAM_ERROR_MARKER, "");
    if (!text) return;
    emittedText = true;
    controller.enqueue(encoder.encode(text));
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await upstreamReader.read();
          buffer += upstreamDecoder.decode(value, { stream: !done });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) emit(controller, readSseEvent(line));

          if (done) break;
        }

        emit(controller, readSseEvent(buffer));

        // Terminal semantics: the stream only succeeds when the model said it finished.
        // A missing or abnormal finish reason (SAFETY, RECITATION, OTHER, …) or an empty
        // answer is surfaced to the client as a stream error, not a silent success.
        if (!finishReason) throw new IncompleteStreamError("The model stream ended before the answer finished.");
        if (!COMPLETED_FINISH_REASONS.has(finishReason)) {
          throw new IncompleteStreamError("The model stopped before finishing the answer.");
        }
        if (!emittedText) throw new IncompleteStreamError("The model returned an empty answer.");
        if (!responseCancelled) controller.close();
      } catch (error) {
        upstreamReader.cancel().catch(() => undefined);
        if (responseCancelled) return;
        if (request.signal.aborted) {
          // The client left; there is nobody to report to.
          controller.error(new Error("Client disconnected."));
          return;
        }
        const reason = error instanceof IncompleteStreamError
          ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "The answer took too long and was stopped."
            : "The model stream failed.";
        controller.enqueue(encoder.encode(`${STREAM_ERROR_MARKER}${JSON.stringify({ error: reason })}`));
        controller.close();
      } finally {
        upstreamReader.releaseLock();
      }
    },
    cancel(reason) {
      responseCancelled = true;
      // Client cancelled the response: stop pulling from Gemini so the provider call ends too.
      return upstreamReader.cancel(reason).catch(() => undefined);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}
