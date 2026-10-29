export const runtime = "nodejs";

type StudyPlan = {
  title: string;
  objective: string;
  estimatedMinutes: number;
  steps: { title: string; detail: string; minutes: number }[];
};

const studyPlanSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise title for the plan." },
    objective: { type: "string", description: "One sentence describing what the learner will be able to do." },
    estimatedMinutes: { type: "integer", minimum: 15, maximum: 120, description: "Total time, between 15 and 120 minutes." },
    steps: {
      type: "array", minItems: 3, maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          minutes: { type: "integer", minimum: 3, maximum: 60 }
        },
        required: ["title", "detail", "minutes"]
      }
    }
  },
  required: ["title", "objective", "estimatedMinutes", "steps"]
};

function isStudyPlan(value: unknown): value is StudyPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<StudyPlan>;
  return typeof plan.title === "string" && typeof plan.objective === "string" &&
    Number.isInteger(plan.estimatedMinutes) && Array.isArray(plan.steps) && plan.steps.length >= 3 && plan.steps.length <= 5 &&
    plan.steps.every((step) => step && typeof step.title === "string" && typeof step.detail === "string" && Number.isInteger(step.minutes));
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return Response.json({ error: "Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server." }, { status: 500 });

  const { topic } = await request.json();
  if (typeof topic !== "string" || !topic.trim()) return Response.json({ error: "Please provide a topic." }, { status: 400 });
  if (topic.length > 600) return Response.json({ error: "Please keep the topic under 600 characters." }, { status: 400 });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Create a practical, focused study plan for this topic: ${topic.trim()}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: studyPlanSchema }
      })
    }
  );

  if (!response.ok) return Response.json({ error: (await response.text()) || "Gemini could not create the plan." }, { status: response.status || 502 });
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
  try {
    const plan: unknown = JSON.parse(text);
    if (!isStudyPlan(plan)) throw new Error("The response did not match the expected plan shape.");
    return Response.json({ plan });
  } catch {
    return Response.json({ error: "Gemini returned an invalid study plan. Please try again." }, { status: 502 });
  }
}
