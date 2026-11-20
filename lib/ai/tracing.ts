// Module 5: observability. Every AI call is traced in Langfuse: which agent
// answered, the tools it used, and the tokens, cost and time.
// Langfuse is optional, like every other service: with no keys, nothing is
// traced and the app works as before.
// The keys are LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

// Kept on globalThis so a dev-server reload doesn't register it twice.
const holder = globalThis as unknown as {
  copperTracing?: { processor: LangfuseSpanProcessor };
};

/**
 * Starts sending traces to Langfuse, once. Called from instrumentation.ts when
 * the server starts, and by the evals. Returns whether tracing is on.
 */
export function startTracing(): boolean {
  if (holder.copperTracing) return true;
  if (!isTracingConfigured()) return false;
  const processor = new LangfuseSpanProcessor();
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  // Every generateText / streamText call becomes a Langfuse observation.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  holder.copperTracing = { processor };
  return true;
}

/** Sends the traces still waiting, before a serverless function freezes. */
export async function flushTracing(): Promise<void> {
  await holder.copperTracing?.processor.forceFlush();
}
