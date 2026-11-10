import { reviewAnswerFlag } from "../../../../../lib/knowledge/answer-flag-service";
import { verifyAdminAccess } from "../../../../../lib/knowledge/server";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ flagId: string }> }
) {
  if (!verifyAdminAccess(request)) {
    return Response.json({ error: "Unauthorized. The Portfolio Owner secret is required to review Answer Flags." }, { status: 401 });
  }
  const { flagId } = await context.params;
  if (!flagId) return Response.json({ error: "Choose an Answer Flag to review." }, { status: 400 });

  const result = await reviewAnswerFlag({ flagId }, { identifierValidation: "nonempty" });
  if (!result.ok) {
    // REST review failures historically return a conflict, including storage failures.
    const status = result.error.code === "answer_flags_unavailable" ? 409 : result.error.status;
    return Response.json({ error: result.error.message }, { status });
  }
  return Response.json({ flag: result.value });
}
