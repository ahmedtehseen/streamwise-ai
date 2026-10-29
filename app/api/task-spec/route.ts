import { z } from "zod";

export const runtime = "nodejs";

const taskSpecJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise, action-oriented task title." },
    summary: { type: "string", description: "A concise explanation of the intended outcome and scope." },
    priority: { type: "string", enum: ["low", "medium", "high"], description: "The suggested implementation priority." },
    acceptanceCriteria: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" }, description: "Observable conditions that define done." },
    implementationNotes: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "Useful technical notes or dependencies; omit guesses." }
  },
  required: ["title", "summary", "priority", "acceptanceCriteria", "implementationNotes"]
};

const taskSpecSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  priority: z.enum(["low", "medium", "high"]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(240)).min(2).max(5),
  implementationNotes: z.array(z.string().trim().min(1).max(240)).min(1).max(4)
});

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return Response.json({ error: "Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server." }, { status: 500 });

  const { request: taskRequest } = await request.json();
  if (typeof taskRequest !== "string" || !taskRequest.trim()) return Response.json({ error: "Please describe the task or feature." }, { status: 400 });
  if (taskRequest.length > 1_500) return Response.json({ error: "Please keep the request under 1,500 characters." }, { status: 400 });

  const geminiResponse = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Turn this request into a concise, buildable task specification. Preserve explicit constraints, do not invent requirements, and make acceptance criteria testable. Request: ${taskRequest.trim()}` }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: taskSpecJsonSchema }
      })
    }
  );

  if (!geminiResponse.ok) return Response.json({ error: (await geminiResponse.text()) || "Gemini could not create the task specification." }, { status: geminiResponse.status || 502 });
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
