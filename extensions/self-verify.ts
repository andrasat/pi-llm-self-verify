import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  currentModelName,
  findProjectRoot,
  formatSelection,
  latestUserPrompt,
  runSelfVerify,
  type VerifyOptions,
} from "../src/self-verify.ts";

const parameters = Type.Object({
  task: Type.String({ description: "Task to generate and rank candidate solutions for" }),
  criteria: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "Optional criterion name to evaluation question mapping",
  })),
  candidates: Type.Optional(Type.Integer({ minimum: 2, maximum: 5, description: "Number of independent candidates" })),
  evals: Type.Optional(Type.Integer({ minimum: 1, description: "Repeated verifier evaluations per criterion" })),
  pivots: Type.Optional(Type.Integer({ minimum: 1, description: "Tournament pivot count" })),
  verifierModel: Type.Optional(Type.String({ description: "Verifier model id" })),
  verifierProvider: Type.Optional(Type.String({ description: "Verifier backend: openai-compatible or vertex" })),
  topLogprobs: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Top token alternatives to request" })),
});

type Params = {
  task: string;
  criteria?: Record<string, string>;
  candidates?: number;
  evals?: number;
  pivots?: number;
  verifierModel?: string;
  verifierProvider?: string;
  topLogprobs?: number;
};

function optionsFor(
  params: Params,
  ctx: { cwd: string; model?: { provider?: string; id?: string }; signal?: AbortSignal },
  runCommand: VerifyOptions["runCommand"],
  onProgress?: VerifyOptions["onProgress"],
): VerifyOptions {
  return {
    cwd: findProjectRoot(ctx.cwd),
    task: params.task,
    criteria: params.criteria,
    candidateCount: params.candidates,
    evals: params.evals,
    pivots: params.pivots,
    verifierModel: params.verifierModel,
    verifierProvider: params.verifierProvider,
    topLogprobs: params.topLogprobs,
    candidateModel: currentModelName(ctx.model),
    signal: ctx.signal,
    runCommand,
    onProgress,
  };
}

export default function selfVerify(pi: ExtensionAPI) {
  const execute = async (
    params: Params,
    ctx: { cwd: string; model?: { provider?: string; id?: string }; signal?: AbortSignal },
    onProgress?: VerifyOptions["onProgress"],
  ) => runSelfVerify(optionsFor(params, ctx, pi.exec, onProgress));

  pi.registerTool({
    name: "self_verify",
    label: "Self-Verify",
    description: "Generate independent read-only candidate solutions, rank them with a logprob verifier, and return the winner. This tool never edits repository files.",
    promptSnippet: "Generate and rank read-only candidate solutions before implementing a high-stakes task",
    promptGuidelines: [
      "Use self_verify when a task benefits from independent candidate solutions before implementation.",
      "Treat self_verify output as a selection aid; still inspect, test, and independently review the winning candidate.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await execute(params, { cwd: ctx.cwd, model: ctx.model, signal }, (message) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details: {} });
      });
      return {
        content: [{ type: "text", text: formatSelection(result) }],
        details: {
          winnerIndex: result.winnerIndex,
          ranking: result.ranking,
          scores: result.scores,
          model: result.model,
          evals: result.evals,
          pivots: result.pivots,
          runDir: result.runDir,
          trailPath: result.trailPath,
        },
      };
    },
  });

  pi.registerCommand("self-verify", {
    description: "Generate and rank read-only candidate solutions for a task",
    handler: async (args, ctx) => {
      const task = args.trim() || latestUserPrompt(ctx.sessionManager.getBranch());
      if (!task) {
        ctx.ui.notify("Usage: /self-verify <task>", "warning");
        return;
      }
      ctx.ui.notify("Self-verify is generating candidates...", "info");
      try {
        const result = await execute(
          { task },
          { cwd: ctx.cwd, model: ctx.model, signal: ctx.signal },
          (message) => ctx.ui.setStatus("self-verify", message),
        );
        pi.sendMessage({
          customType: "self-verify",
          content: formatSelection(result),
          display: true,
          details: {
            winnerIndex: result.winnerIndex,
            ranking: result.ranking,
            scores: result.scores,
            model: result.model,
            evals: result.evals,
            pivots: result.pivots,
            runDir: result.runDir,
            trailPath: result.trailPath,
          },
        }, { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("self-verify", undefined);
      }
    },
  });
}
