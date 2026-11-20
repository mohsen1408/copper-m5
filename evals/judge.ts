// Module 5: the AI judge ("LLM as a judge"). It reads the customer's
// question, what the tools returned and the agent's reply, then checks each
// thing a good answer must do. Like every AI call, it goes through
// lib/ai/call.ts, so it's logged too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { GoldenCase } from "@/evals/golden-set";

export const verdictSchema = z.object({
  checks: z
    .array(
      z.object({
        rule: z.string().describe("The rule being checked, copied exactly."),
        met: z.boolean().describe("Does the reply do this?"),
        why: z.string().describe("One short sentence of evidence."),
      }),
    )
    .describe("One entry per rule, in the same order."),
});

export type Verdict = z.infer<typeof verdictSchema>;

export const JUDGE_INSTRUCTIONS = `You grade a customer-support chatbot for Copper State Labs.
You get the customer's message, the tool results the chatbot saw, its reply, and a list of rules.
For each rule, decide whether the reply does what the rule says. Judge only the reply (use the tool results to check facts).
Be strict but fair: wording can differ, but the meaning must match. A reply that is an error message, or that only asks a question when the rule needs an answer, does not meet the rule.`;

/** Grades one answer. Returns one check per rule. */
export async function judge(
  testCase: GoldenCase,
  reply: string,
  toolCalls: { name: string; output: unknown }[],
): Promise<Verdict> {
  const tools = toolCalls.length
    ? toolCalls
        .map((t) => `- ${t.name}: ${JSON.stringify(t.output).slice(0, 600)}`)
        .join("\n")
    : "(no tools used)";
  const { output } = await callObject(
    { module: 5, feature: "eval-judge" },
    {
      instructions: JUDGE_INSTRUCTIONS,
      prompt: `Customer: ${testCase.question}

Tool results:
${tools}

Chatbot reply:
${reply}

Rules:
${testCase.mustDo.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}`,
      schema: verdictSchema,
      telemetry: { functionId: "eval-judge" },
    },
  );
  return output;
}
