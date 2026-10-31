import { z } from "zod";

export const taskSpecJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise, action-oriented task title." },
    summary: { type: "string", description: "A concise explanation of the intended outcome and scope." },
    priority: { type: "string", enum: ["low", "medium", "high"], description: "The suggested implementation priority." },
    acceptanceCriteria: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" }, description: "Observable conditions that define done." },
    implementationNotes: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "Useful technical notes or dependencies; omit guesses." }
  },
  required: ["title", "summary", "priority", "acceptanceCriteria", "implementationNotes"]
} as const;

export const taskSpecSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  priority: z.enum(["low", "medium", "high"]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(240)).min(2).max(5),
  implementationNotes: z.array(z.string().trim().min(1).max(240)).min(1).max(4)
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;
