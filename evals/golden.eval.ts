// @vitest-environment node
// Module 5: the golden-set evaluation. Runs every golden question through the
// real Ask Copper (real model, real tools) for each design: the two agents
// with a handoff ("multi") and one Support agent ("single"). For each answer
// it records the time, tokens and cost, checks the expected tool was used, and
// has the AI judge grade it. Every answer is a Langfuse trace, and the scores
// (passed, judge_score, cost_usd, latency_seconds) are attached to it, so the
// two designs can be compared in Langfuse.
// Run: npm run eval   (needs GOOGLE_GENERATIVE_AI_API_KEY; Langfuse optional)
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isAiConfigured } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { flushTracing, startTracing } from "@/lib/ai/tracing";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  type Architecture,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import { GOLDEN_SET, type GoldenCase } from "@/evals/golden-set";
import { judge } from "@/evals/judge";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** The share of golden questions the shipped design (multi) must pass. */
const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE ?? 0.8);
/** Pause between questions, to stay under the free tier's requests per minute. */
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 5000);
/** Pause before retrying a question that failed with an error. */
const RETRY_DELAY_MS = Number(process.env.EVAL_RETRY_DELAY_MS ?? 30000);
const ARCHITECTURES = (process.env.EVAL_ARCHITECTURES ?? "multi,single")
  .split(",")
  .map((a) => a.trim()) as Architecture[];
const RUN_ID = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
/** EVAL_CASES=price,small-refund runs just those (a quick check). */
const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());
const CASES = ONLY ? GOLDEN_SET.filter((c) => ONLY.includes(c.id)) : GOLDEN_SET;

type AiCallRow = {
  feature: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

type CaseResult = {
  architecture: Architecture;
  id: string;
  passed: boolean;
  judgeScore: number;
  usedExpectedTool: boolean;
  tools: string[];
  agent: string;
  latencySeconds: number;
  costUsd: number;
  tokens: number;
  reply: string;
  failed: string[];
  traceId?: string;
  /** The chat failed with an error (often a rate limit), not a wrong answer. */
  errored: boolean;
};

const results: CaseResult[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one golden question and grades it. */
async function runCase(
  architecture: Architecture,
  testCase: GoldenCase,
): Promise<CaseResult> {
  // Collect the [ai_calls] rows the app logs for this answer (tokens, cost).
  const rows: AiCallRow[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
    if (args[0] === "[ai_calls]") rows.push(JSON.parse(String(args[1])));
  });
  const started = performance.now();
  let progress;
  try {
    progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: testCase.question }],
          useTools: true,
          desk: testCase.desk,
          architecture,
          sessionId: `${RUN_ID}-${architecture}`,
          tags: ["eval", RUN_ID],
        })
      ).progress,
    );
  } finally {
    spy.mockRestore();
  }
  const latencySeconds = (performance.now() - started) / 1000;
  const answerRows = rows.filter((r) => r.feature !== "eval-judge");
  const costUsd = answerRows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const tokens = answerRows.reduce(
    (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );

  const calls = toolCallsOf(progress);
  const tools = calls.map((c) => c.name);
  const usedExpectedTool =
    !testCase.tools || testCase.tools.some((t) => tools.includes(t));

  let checks: { rule: string; met: boolean; why: string }[];
  if (progress.status !== "done") {
    checks = testCase.mustDo.map((rule) => ({
      rule,
      met: false,
      why: "The chat failed with an error.",
    }));
  } else {
    try {
      checks = (await judge(testCase, progress.reply, calls)).checks;
    } catch (error) {
      checks = testCase.mustDo.map((rule) => ({
        rule,
        met: false,
        why: `The judge failed: ${error instanceof Error ? error.message : error}`,
      }));
    }
  }
  const met = checks.filter((c) => c.met).length;
  const judgeScore = testCase.mustDo.length ? met / testCase.mustDo.length : 1;
  const failed = [
    ...checks.filter((c) => !c.met).map((c) => `${c.rule} (${c.why})`),
    ...(usedExpectedTool
      ? []
      : [
          `Didn't use ${testCase.tools!.join(" or ")} (used: ${tools.join(", ") || "none"})`,
        ]),
  ];
  return {
    architecture,
    id: testCase.id,
    passed: judgeScore === 1 && usedExpectedTool,
    judgeScore,
    usedExpectedTool,
    tools,
    agent: progress.agent ?? "copper",
    latencySeconds,
    costUsd,
    tokens,
    reply: progress.reply,
    failed,
    traceId: progress.traceId,
    errored: progress.status !== "done",
  };
}

/** Attaches the scores to the answer's Langfuse trace. */
function scoreInLangfuse(langfuse: LangfuseClient, r: CaseResult) {
  if (!r.traceId) return;
  const base = {
    traceId: r.traceId,
    metadata: { runId: RUN_ID, architecture: r.architecture, case: r.id },
  };
  langfuse.score.create({
    ...base,
    name: "passed",
    value: r.passed ? 1 : 0,
    dataType: "NUMERIC",
    comment: r.failed.join(" | ") || "All rules met",
  });
  langfuse.score.create({
    ...base,
    name: "judge_score",
    value: r.judgeScore,
    dataType: "NUMERIC",
  });
  langfuse.score.create({
    ...base,
    name: "cost_usd",
    value: r.costUsd,
    dataType: "NUMERIC",
  });
  langfuse.score.create({
    ...base,
    name: "latency_seconds",
    value: r.latencySeconds,
    dataType: "NUMERIC",
  });
}

type Summary = {
  architecture: Architecture;
  passed: number;
  total: number;
  passRate: number;
  avgJudgeScore: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgLatencySeconds: number;
  avgTokens: number;
};

function summarize(architecture: Architecture): Summary {
  const rs = results.filter((r) => r.architecture === architecture);
  const total = rs.length || 1;
  const sum = (f: (r: CaseResult) => number) =>
    rs.reduce((s, r) => s + f(r), 0);
  return {
    architecture,
    passed: rs.filter((r) => r.passed).length,
    total: rs.length,
    passRate: rs.filter((r) => r.passed).length / total,
    avgJudgeScore: sum((r) => r.judgeScore) / total,
    totalCostUsd: sum((r) => r.costUsd),
    avgCostUsd: sum((r) => r.costUsd) / total,
    avgLatencySeconds: sum((r) => r.latencySeconds) / total,
    avgTokens: sum((r) => r.tokens) / total,
  };
}

const NAMES: Record<Architecture, string> = {
  multi: "Multi agent (Copper + Refund agent)",
  single: "Single agent (Support agent)",
};

function report(summaries: Summary[]): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `## Ask Copper golden-set eval`,
    ``,
    `Run \`${RUN_ID}\`: ${CASES.length} questions, graded by an AI judge. The multi agent must pass at least ${pct(MIN_PASS_RATE)}.`,
    ``,
    `| Design | Pass rate | Avg judge score | Avg cost per answer | Total cost | Avg time per answer | Avg tokens |`,
    `|---|---|---|---|---|---|---|`,
    ...summaries.map(
      (s) =>
        `| ${NAMES[s.architecture]} | **${pct(s.passRate)}** (${s.passed}/${s.total}) | ${s.avgJudgeScore.toFixed(2)} | $${s.avgCostUsd.toFixed(5)} | $${s.totalCostUsd.toFixed(4)} | ${s.avgLatencySeconds.toFixed(1)} s | ${Math.round(s.avgTokens)} |`,
    ),
    ``,
    `| Question | ${summaries.map((s) => NAMES[s.architecture].split(" (")[0]).join(" | ")} |`,
    `|---|${summaries.map(() => "---").join("|")}|`,
    ...CASES.map(
      (c) =>
        `| ${c.id} | ${summaries
          .map((s) => {
            const r = results.find(
              (x) => x.id === c.id && x.architecture === s.architecture,
            );
            return r
              ? `${r.passed ? "✅" : "❌"} ${r.latencySeconds.toFixed(1)} s`
              : "–";
          })
          .join(" | ")} |`,
    ),
  ];
  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    lines.push(``, `### What failed`, ``);
    for (const r of failures)
      lines.push(
        `- **${r.architecture} / ${r.id}**: ${r.failed.join("; ").slice(0, 400)}`,
      );
  }
  return lines.join("\n");
}

describe.skipIf(!isAiConfigured() && !process.env.CI)("golden set", () => {
  const tracing = startTracing();
  const langfuse = tracing ? new LangfuseClient() : undefined;

  it("has an AI key", () => {
    expect(
      isAiConfigured(),
      "Set GOOGLE_GENERATIVE_AI_API_KEY (a repo secret in CI)",
    ).toBe(true);
  });

  // Both designs answer each question back to back, so they meet the same
  // conditions (like the model's rate limits) and the comparison is fair.
  it(
    "runs every golden question on each design and grades it",
    async () => {
      for (const testCase of CASES) {
        for (const architecture of ARCHITECTURES) {
          let r = await runCase(architecture, testCase);
          if (r.errored) {
            // An error (not a wrong answer) is usually a rate limit: wait and
            // try once more.
            console.log(`RETRY ${architecture}/${r.id} after an error`);
            await sleep(RETRY_DELAY_MS);
            r = await runCase(architecture, testCase);
          }
          results.push(r);
          if (langfuse) scoreInLangfuse(langfuse, r);
          console.log(
            `${r.passed ? "PASS" : "FAIL"} ${architecture}/${r.id} ${r.latencySeconds.toFixed(1)}s $${r.costUsd.toFixed(5)}${r.failed.length ? ` — ${r.failed.join("; ").slice(0, 300)}` : ""}`,
          );
          await sleep(DELAY_MS);
        }
      }
    },
    45 * 60 * 1000,
  );

  it(`the multi agent passes at least ${Math.round(MIN_PASS_RATE * 100)}% of the golden set`, () => {
    if (!ARCHITECTURES.includes("multi")) return;
    const s = summarize("multi");
    expect(
      s.passRate,
      `The multi agent passed ${s.passed}/${s.total}; it needs ${Math.round(MIN_PASS_RATE * 100)}%`,
    ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
  });

  afterAll(async () => {
    const summaries = ARCHITECTURES.map(summarize);
    const markdown = report(summaries);
    console.log(`\n${markdown}\n`);
    mkdirSync("evals/results", { recursive: true });
    writeFileSync(
      "evals/results/latest.json",
      JSON.stringify({ runId: RUN_ID, summaries, results }, null, 2),
    );
    writeFileSync("evals/results/latest.md", markdown);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    await langfuse?.flush();
    await flushTracing();
  }, 120_000);
});
