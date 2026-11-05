import { generationUnavailableResponse, requestPublicGeneration } from "../../../lib/public-generation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { messages?: unknown } | null;
  const messages = body?.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("Please provide at least one message.", { status: 400 });
  }

  const contents = messages
    .slice(-20)
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message.content === "string" &&
        Boolean(message.content.trim())
    )
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content.trim() }]
    }));

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
