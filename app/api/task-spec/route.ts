import { taskSpecJsonSchema, taskSpecSchema } from "../../../lib/task-spec";
import { hasValidImageSignature, isSupportedImageType, MAX_IMAGE_BYTES } from "../../../lib/image-upload";

export const runtime = "nodejs";

type TaskSpecInput = { request: string; image?: File };

async function readTaskSpecInput(request: Request): Promise<TaskSpecInput | Response> {
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const formData = await request.formData().catch(() => null);
    if (!formData) return Response.json({ error: "The screenshot upload could not be read." }, { status: 400 });

    const taskRequest = formData.get("request");
    const image = formData.get("image");
    if (typeof taskRequest !== "string") return Response.json({ error: "The screenshot context is invalid." }, { status: 400 });
    if (!(image instanceof File) || image.size === 0) return Response.json({ error: "Choose a screenshot to analyze." }, { status: 400 });
    if (!isSupportedImageType(image.type)) return Response.json({ error: "Use a PNG, JPEG, or WebP screenshot." }, { status: 415 });
    if (image.size > MAX_IMAGE_BYTES) return Response.json({ error: "Keep the screenshot under 5 MB." }, { status: 413 });
    return { request: taskRequest, image };
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.request !== "string") return Response.json({ error: "Please describe the task or feature." }, { status: 400 });
  return { request: body.request };
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return Response.json({ error: "Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server." }, { status: 500 });

  const input = await readTaskSpecInput(request);
  if (input instanceof Response) return input;

  const taskRequest = input.request.trim();
  if (!taskRequest && !input.image) return Response.json({ error: "Please describe the task or choose a screenshot." }, { status: 400 });
  if (taskRequest.length > 1_500) return Response.json({ error: "Please keep the request under 1,500 characters." }, { status: 400 });

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
  if (input.image) {
    const imageBytes = new Uint8Array(await input.image.arrayBuffer());
    if (!hasValidImageSignature(imageBytes, input.image.type)) return Response.json({ error: "The file contents do not match the selected image format." }, { status: 415 });
    parts.push({ inlineData: { mimeType: input.image.type, data: Buffer.from(imageBytes).toString("base64") } });
    parts.push({ text: `Analyze this product screenshot and turn the visible issue or requested improvement into a concise, buildable task specification. Ground every claim in visible evidence, preserve the supplied context, do not invent product behavior, and make acceptance criteria testable.${taskRequest ? `\nAdditional context: ${taskRequest}` : ""}` });
  } else {
    parts.push({ text: `Turn this request into a concise, buildable task specification. Preserve explicit constraints, do not invent requirements, and make acceptance criteria testable. Request: ${taskRequest}` });
  }

  const geminiResponse = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: taskSpecJsonSchema }
      })
    }
  );

  if (!geminiResponse.ok) {
    const fallback = "Gemini could not create the task specification. Please try again.";
    if (geminiResponse.status === 429 || geminiResponse.status === 503) {
      return Response.json({ error: "Gemini is temporarily busy. Please try again in a moment." }, { status: 503 });
    }
    if (geminiResponse.status === 401 || geminiResponse.status === 403) {
      return Response.json({ error: "Gemini could not authenticate the API key. Check GEMINI_API_KEY and try again." }, { status: 502 });
    }
    return Response.json({ error: fallback }, { status: geminiResponse.status || 502 });
  }
  const payload = await geminiResponse.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
  try {
    const parsed = taskSpecSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("Invalid task spec");
    return Response.json({ taskSpec: parsed.data });
  } catch {
    return Response.json({ error: "Gemini returned an invalid task specification. Please try again." }, { status: 502 });
  }
}
