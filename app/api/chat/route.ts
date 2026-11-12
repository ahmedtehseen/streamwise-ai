import { generationUnavailableResponse, requestPublicGeneration } from "../../../lib/public-generation";
import { hasValidImageSignature, isSupportedImageType, MAX_IMAGE_BYTES } from "../../../lib/image-upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
  for (const message of messages.slice(-20)) {
    if ((message?.role !== "user" && message?.role !== "assistant") || typeof message.content !== "string") continue;
    const parts: Part[] = [];
    if (message.content.trim()) parts.push({ text: message.content.trim() });
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

  function readTextFromSseEvent(line: string) {
    if (!line.startsWith("data: ")) return "";

    try {
      const payload = JSON.parse(line.slice(6));
      return payload.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text ?? "")
        .join("") ?? "";
    } catch {
      return "";
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await upstreamReader.read();
          buffer += upstreamDecoder.decode(value, { stream: !done });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const text = readTextFromSseEvent(line);
            if (text) controller.enqueue(encoder.encode(text));
          }

          if (done) break;
        }

        const remainingText = readTextFromSseEvent(buffer);
        if (remainingText) controller.enqueue(encoder.encode(remainingText));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        upstreamReader.releaseLock();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}
