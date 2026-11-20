// Runs once when the Next.js server starts (Module 5): turns on Langfuse
// tracing when its keys are set. See lib/ai/tracing.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTracing } = await import("@/lib/ai/tracing");
  startTracing();
}
