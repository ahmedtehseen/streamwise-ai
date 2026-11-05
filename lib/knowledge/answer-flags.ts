import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const sourceReferenceSchema = z.object({
  id: z.string().min(1),
  documentName: z.string().min(1),
  headingPath: z.array(z.string()),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerpt: z.string().min(1)
});

const responseSnapshotSchema = z.object({
  version: z.literal(1),
  nonce: z.string().uuid(),
  question: z.string().min(1),
  outcome: z.enum(["answered", "insufficient_evidence"]),
  paragraphs: z.array(z.object({
    text: z.string(),
    sourceReferences: z.array(sourceReferenceSchema)
  })),
  degradedSearch: z.boolean(),
  respondedAt: z.string().datetime()
}).superRefine((snapshot, context) => {
  if (snapshot.outcome === "insufficient_evidence" && snapshot.paragraphs.length !== 0) {
    context.addIssue({ code: "custom", message: "Insufficient Evidence cannot contain answer paragraphs." });
  }
  if (snapshot.outcome === "answered" && snapshot.paragraphs.length === 0) {
    context.addIssue({ code: "custom", message: "A Grounded Answer must contain answer paragraphs." });
  }
});

export type AnswerResponseSnapshot = z.infer<typeof responseSnapshotSchema>;

function signingKey() {
  const secret = process.env.ANSWER_FLAG_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Answer Flags require ANSWER_FLAG_SECRET or SUPABASE_SERVICE_ROLE_KEY.");
  return createHmac("sha256", secret).update("streamwise-answer-flags-v1").digest();
}

function signature(payload: string) {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function issueAnswerResponseIdentity(
  question: string,
  response: {
    outcome: "answered" | "insufficient_evidence";
    paragraphs: Array<{ text: string; sourceReferences: Array<z.infer<typeof sourceReferenceSchema>> }>;
    degradedSearch?: boolean;
  }
) {
  const snapshot = responseSnapshotSchema.parse({
    version: 1,
    nonce: randomUUID(),
    question,
    outcome: response.outcome,
    paragraphs: response.paragraphs,
    degradedSearch: response.degradedSearch === true,
    respondedAt: new Date().toISOString()
  });
  const encodedSnapshot = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return {
    responseId: `${encodedSnapshot}.${signature(encodedSnapshot)}`,
    respondedAt: snapshot.respondedAt
  };
}

export function verifyAnswerResponseIdentity(responseId: string): AnswerResponseSnapshot | null {
  const separator = responseId.lastIndexOf(".");
  if (separator <= 0 || responseId.length > 65_536) return null;
  const encodedSnapshot = responseId.slice(0, separator);
  const suppliedSignature = responseId.slice(separator + 1);
  const expectedSignature = signature(encodedSnapshot);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    return responseSnapshotSchema.parse(JSON.parse(Buffer.from(encodedSnapshot, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function answerResponseFingerprint(responseId: string) {
  return createHash("sha256").update(responseId).digest("hex");
}

