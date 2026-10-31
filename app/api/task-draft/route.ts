import { taskSpecJsonSchema, taskSpecSchema, type TaskSpec } from "../../../lib/task-spec";

export const runtime = "nodejs";

const CREATE_DRAFT_TOOL = "create_task_draft";

function createTaskDraft(taskSpec: TaskSpec) {
  return { id: crypto.randomUUID(), status: "draft" as const, createdAt: new Date().toISOString(), taskSpec };
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return Response.json({ error: "Missing GEMINI_API_KEY. Add it to .env.local and restart the dev server." }, { status: 500 });

  const body = await request.json().catch(() => null);
  const approvedSpec = taskSpecSchema.safeParse(body?.taskSpec);
  if (!approvedSpec.success) return Response.json({ error: "Review the task spec before creating a draft." }, { status: 400 });

  const geminiResponse = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Create a draft task from this human-approved specification. Copy every field exactly and do not add requirements.\n${JSON.stringify(approvedSpec.data)}` }] }],
        tools: [{ functionDeclarations: [{ name: CREATE_DRAFT_TOOL, description: "Create a local draft task for human review. This never publishes or sends the task.", parameters: taskSpecJsonSchema }] }],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [CREATE_DRAFT_TOOL] } },
        generationConfig: { temperature: 0 }
      })
    }
  );

  if (!geminiResponse.ok) {
    if (geminiResponse.status === 429 || geminiResponse.status === 503) return Response.json({ error: "Gemini is temporarily busy. Please try again in a moment." }, { status: 503 });
    if (geminiResponse.status === 401 || geminiResponse.status === 403) return Response.json({ error: "Gemini could not authenticate the API key. Check GEMINI_API_KEY and try again." }, { status: 502 });
    return Response.json({ error: "Gemini could not request the draft tool." }, { status: geminiResponse.status || 502 });
  }

  const payload = await geminiResponse.json();
  const functionCall = payload.candidates?.[0]?.content?.parts?.find((part: { functionCall?: { name?: string; args?: unknown } }) => part.functionCall)?.functionCall;
  if (functionCall?.name !== CREATE_DRAFT_TOOL) return Response.json({ error: "Gemini did not request the approved draft tool." }, { status: 502 });

  const toolArguments = taskSpecSchema.safeParse(functionCall.args);
  if (!toolArguments.success || JSON.stringify(toolArguments.data) !== JSON.stringify(approvedSpec.data)) {
    return Response.json({ error: "Gemini changed the approved task spec, so no draft was created." }, { status: 502 });
  }

  return Response.json({ draft: createTaskDraft(toolArguments.data), toolName: CREATE_DRAFT_TOOL });
}
