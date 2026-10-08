import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "powerline-tps";
const IDLE_STATUS = "— tok/s";
const MIN_DURATION_MS = 100;

/** Match Oh My Pi's output TPS formula: generated output tokens / total request time. */
export function calculateTps(outputTokens: number, elapsedMs: number): number | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_DURATION_MS) return undefined;
  return (outputTokens * 1_000) / elapsedMs;
}

/** Estimate all generated content, not only user-visible text, at about four characters per token. */
export function estimateGeneratedTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  const generatedCharacters = content.reduce((total, block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return total;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      return total + block.text.length;
    }
    if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
      return total + block.thinking.length;
    }
    if (block.type === "toolCall" && "name" in block && typeof block.name === "string" && "arguments" in block) {
      const argumentsText = JSON.stringify(block.arguments);
      return total + block.name.length + (argumentsText?.length ?? 0);
    }
    return total;
  }, 0);
  return generatedCharacters / 4;
}

function outputTokenCount(message: { role: string; usage?: { output?: number } }): number | undefined {
  if (message.role !== "assistant") return undefined;
  const output = message.usage?.output;
  return typeof output === "number" && Number.isFinite(output) && output > 0 ? output : undefined;
}

export default function registerPowerlineTps(pi: ExtensionAPI): void {
  let startedAt: number | undefined;
  let latestEstimatedTokens = 0;
  let hasLiveUsage = false;
  let lastStatus = IDLE_STATUS;

  const publish = (ctx: ExtensionContext, tps: number | undefined, estimated = false) => {
    if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return;
    lastStatus = `${estimated ? "~" : ""}${Math.round(tps)} tok/s`;
    ctx.ui.setStatus(STATUS_KEY, lastStatus);
  };

  const resetTracking = () => {
    startedAt = undefined;
    latestEstimatedTokens = 0;
    hasLiveUsage = false;
  };

  pi.on("session_start", (_event, ctx) => {
    resetTracking();
    // Keep the segment visible even before the first generated response.
    ctx.ui.setStatus(STATUS_KEY, lastStatus);
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    resetTracking();
    const timestamp = event.message.timestamp;
    startedAt = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
    // Preserve the previous average while the next response is starting.
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const now = Date.now();
    startedAt ??= now;
    const elapsedMs = now - startedAt;
    const usageTokens = outputTokenCount(event.message);

    if (usageTokens !== undefined) {
      // Provider output usage includes reasoning tokens when the provider reports it.
      hasLiveUsage = true;
      publish(ctx, calculateTps(usageTokens, elapsedMs));
      return;
    }

    // Fall back to all streamed generated content if usage only arrives at completion.
    // As in OMP, TPS is cumulative output / total elapsed request time, not a delta window.
    if (!hasLiveUsage) {
      const estimatedTokens = estimateGeneratedTokens(event.message.content);
      if (estimatedTokens > latestEstimatedTokens) latestEstimatedTokens = estimatedTokens;
      publish(ctx, calculateTps(latestEstimatedTokens, elapsedMs), true);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const now = Date.now();
    startedAt ??= now;
    const outputTokens = outputTokenCount(event.message);
    const finalTokens = outputTokens ?? (latestEstimatedTokens > 0 ? latestEstimatedTokens : undefined);
    if (finalTokens !== undefined) {
      publish(ctx, calculateTps(finalTokens, now - startedAt), outputTokens === undefined);
    }
    // Leave the last average visible while Pi is idle.
    resetTracking();
  });
}
