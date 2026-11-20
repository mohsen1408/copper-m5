// @vitest-environment node
// Module 5: the pieces that make Ask Copper safe to ship, checked with a mock
// model (no AI key, no Langfuse key, no cost): the single Support agent used
// for the comparison, tracing staying off without keys, the golden set, and
// the AI judge.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import type { Desk } from "@/lib/copper/orders";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}
const toolNames = (i: number) =>
  (model.doStreamCalls[i].tools ?? []).map((t) => t.name).sort();

const desk: Desk = { limitUsd: 50, refunds: [] };

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("single agent vs multi agent", () => {
  it("the single Support agent has every tool, no handoff, and refunds by itself", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Order 1001 ($7.99) is refunded."),
    );
    const progress = await ask({
      messages: [{ role: "user", content: "Refund order 1001" }],
      useTools: true,
      desk,
      architecture: "single",
    });
    expect(progress.agent).toBe("support");
    expect(progress.reply).toBe("Order 1001 ($7.99) is refunded.");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(toolCallsOf(progress)[0]).toMatchObject({
      name: "request_refund",
      output: { status: "refunded", amountUsd: 7.99 },
    });
    expect(toolNames(0)).toEqual([
      "calculate_cost",
      "check_availability",
      "get_orders",
      "get_prices",
      "get_products",
      "request_refund",
      "search_docs",
    ]);
  });

  it("the multi agent (the default) still hands refunds to the Refund agent", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund #1001" }),
      calls("request_refund", { orderId: "1001" }),
      says("Done: $7.99 refunded."),
    );
    const progress = await ask({
      messages: [{ role: "user", content: "Refund order 1001" }],
      useTools: true,
      desk,
    });
    expect(progress.agent).toBe("refund");
    expect(toolNames(0)).toContain("transfer_to_refund_agent");
    expect(toolNames(1)).toEqual([
      "get_orders",
      "request_refund",
      "transfer_to_copper",
    ]);
  });

  it("without Langfuse keys nothing is traced and the chat still works", async () => {
    model = modelStreaming(says("Hello!"));
    const progress = await ask({
      messages: [{ role: "user", content: "Hi" }],
      useTools: true,
    });
    expect(progress.reply).toBe("Hello!");
    expect(progress.traceId).toBeUndefined();
    const { isTracingConfigured, startTracing } =
      await import("@/lib/ai/tracing");
    expect(isTracingConfigured()).toBe(false);
    expect(startTracing()).toBe(false);
  });
});

describe("the golden set and the AI judge", () => {
  it("every golden question has an id, rules and a desk", async () => {
    const { GOLDEN_SET } = await import("@/evals/golden-set");
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    expect(new Set(GOLDEN_SET.map((c) => c.id)).size).toBe(GOLDEN_SET.length);
    for (const c of GOLDEN_SET) {
      expect(c.mustDo.length, c.id).toBeGreaterThan(0);
      expect(c.desk.limitUsd, c.id).toBe(50);
    }
    // Refunds, a trick message and an off-topic question are all covered.
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "small-refund",
        "big-refund",
        "fake-approval",
        "off-topic",
      ]),
    );
  });

  it("the judge returns one check per rule, through lib/ai/call.ts", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    const verdict = {
      checks: [
        {
          rule: "Says Copper Home costs $149.",
          met: true,
          why: "It says $149.",
        },
      ],
    };
    model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const logged: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args) => {
      if (args[0] === "[ai_calls]") logged.push(String(args[1]));
    });
    const { judge } = await import("@/evals/judge");
    const { GOLDEN_SET } = await import("@/evals/golden-set");
    const price = GOLDEN_SET.find((c) => c.id === "price")!;
    expect(
      await judge(price, "Copper Home is $149.", [
        { name: "get_prices", output: { products: [] } },
      ]),
    ).toEqual(verdict);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Says Copper Home costs $149.");
    expect(prompt).toContain("Copper Home is $149.");
    expect(JSON.parse(logged[0])).toMatchObject({
      module: 5,
      feature: "eval-judge",
    });
  });
});
