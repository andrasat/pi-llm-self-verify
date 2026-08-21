import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findProjectRoot,
  latestUserPrompt,
  normalizeCriteria,
  pivotPairs,
  positiveInt,
  rankFromPairs,
  ringPairs,
  runSelfVerify,
  scoreResponse,
} from "../src/self-verify.ts";

test("normalizes criteria and validates positive integers", () => {
  assert.deepEqual(normalizeCriteria(["correctness"]), [
    { name: "correctness", description: "correctness" },
  ]);
  assert.equal(positiveInt(undefined, "count", 3), 3);
  assert.throws(() => positiveInt(0, "count", 3), /positive integer/);
  assert.throws(() => normalizeCriteria({}), /1-4/);
});

test("extracts literal and logprob scores on the A-T scale", () => {
  assert.deepEqual(scoreResponse({
    text: "<score_A> A </score_A> <score_B> T </score_B>",
    positions: [],
  }), [1, 0]);

  assert.deepEqual(scoreResponse({
    text: "",
    positions: [
      { token: "<score_A>" },
      { token: " A", top_logprobs: [{ token: "A", logprob: 0 }] },
      { token: "</score_A>" },
      { token: "<score_B>" },
      { token: " T", top_logprobs: [{ token: "T", logprob: 0 }] },
      { token: "</score_B>" },
    ],
  }), [1, 0]);
});

test("builds ring and pivot tournament pairs", () => {
  const ring = ringPairs(4, () => 0.5);
  assert.equal(ring.length, 4);
  assert.equal(new Set(ring.flat()).size, 4);
  assert.deepEqual(pivotPairs(4, [1, 3]), [[0, 1], [0, 3], [2, 1], [2, 3], [1, 3]]);

  const ranked = rankFromPairs(3, [[0, 1], [1, 2], [2, 0]], 1, (a, b) => [a, b]);
  assert.equal(ranked.winnerIndex, 2);
  assert.deepEqual(ranked.ranking, [2, 1, 0]);
});

test("finds the latest real user prompt", () => {
  assert.equal(latestUserPrompt([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "/self-verify" }] } },
    { type: "message", message: { role: "user", content: "second" } },
  ]), "second");
});

test("rejects remote HTTP verifier endpoints before sending credentials", async () => {
  const original = {
    base: process.env.VERIFIER_BASE_URL,
    key: process.env.VERIFIER_API_KEY,
    model: process.env.VERIFIER_MODEL,
  };
  process.env.VERIFIER_BASE_URL = "http://example.test/v1";
  process.env.VERIFIER_API_KEY = "test";
  process.env.VERIFIER_MODEL = "test-model";
  try {
    await assert.rejects(runSelfVerify({
      cwd: process.cwd(),
      task: "test",
      candidateCount: 2,
      pivots: 1,
      runCommand: async () => { throw new Error("must not generate"); },
    }), /HTTPS/);
  } finally {
    for (const [name, value] of Object.entries({
      VERIFIER_BASE_URL: original.base,
      VERIFIER_API_KEY: original.key,
      VERIFIER_MODEL: original.model,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("uses Vertex response logprobs when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-self-verify-vertex-"));
  await mkdir(join(root, ".git"));
  const originalFetch = globalThis.fetch;
  const names = [
    "VERIFIER_PROVIDER", "VERIFIER_MODEL", "VERIFIER_BASE_URL", "OPENAI_BASE_URL",
    "VERIFIER_API_KEY", "VERTEX_API_KEY", "VERTEX_ACCESS_TOKEN", "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.VERIFIER_PROVIDER = "vertex";
  process.env.VERIFIER_MODEL = "gemini-2.5-flash";
  process.env.VERTEX_ACCESS_TOKEN = "test-token";
  process.env.GOOGLE_CLOUD_PROJECT = "test-project";
  process.env.GOOGLE_CLOUD_LOCATION = "global";
  for (const name of ["VERIFIER_BASE_URL", "OPENAI_BASE_URL", "VERIFIER_API_KEY", "VERTEX_API_KEY"]) delete process.env[name];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { generationConfig: { logprobs: number } };
    assert.equal(body.generationConfig.logprobs, 5);
    const tokens = ["<score_A>", " A", "</score_A>", "<score_B>", " T", "</score_B>"];
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "<score_A> A </score_A> <score_B> T </score_B>" }] },
        logprobsResult: {
          topCandidates: tokens.map((token) => ({ candidates: [{ token, logProbability: 0 }] })),
          chosenCandidates: tokens.map((token) => ({ token, logProbability: 0 })),
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let generated = 0;
  try {
    const result = await runSelfVerify({
      cwd: root,
      task: "choose a candidate",
      candidateCount: 2,
      evals: 1,
      pivots: 1,
      topLogprobs: 5,
      runCommand: async () => ({
        stdout: JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: `candidate ${++generated}` }] },
        }),
        stderr: "",
        code: 0,
      }),
    });
    assert.equal(result.model, "gemini-2.5-flash");
    assert.equal(result.candidates.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("runs a read-only candidate selection and records artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-self-verify-"));
  await mkdir(join(root, ".git"));
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    base: process.env.VERIFIER_BASE_URL,
    key: process.env.VERIFIER_API_KEY,
    model: process.env.VERIFIER_MODEL,
    evals: process.env.VERIFIER_EVALS,
    pivots: process.env.VERIFIER_PIVOTS,
  };
  process.env.VERIFIER_BASE_URL = "http://localhost/v1";
  process.env.VERIFIER_API_KEY = "test";
  process.env.VERIFIER_MODEL = "test-model";
  process.env.VERIFIER_EVALS = "1";
  process.env.VERIFIER_PIVOTS = "1";
  let generated = 0;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: [{ content: string }]; top_logprobs: number };
    assert.equal(body.top_logprobs, 5);
    const prompt = body.messages[0].content;
    const trajectoryA = prompt.match(/Trajectory A:\n([\s\S]*?)\n\nTrajectory B:/)?.[1] || "";
    const trajectoryB = prompt.match(/Trajectory B:\n([\s\S]*?)\n\nRating scale:/)?.[1] || "";
    const score = (trajectory: string) => trajectory.includes("candidate 2") ? "A" : "T";
    return new Response(JSON.stringify({
      choices: [{
        message: { content: `<score_A> ${score(trajectoryA)} </score_A> <score_B> ${score(trajectoryB)} </score_B>` },
        logprobs: null,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await runSelfVerify({
      cwd: root,
      task: "choose a candidate",
      candidateCount: 3,
      topLogprobs: 5,
      runCommand: async () => {
        generated += 1;
        return {
          stdout: JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `candidate ${generated}` }] },
          }),
          stderr: "",
          code: 0,
        };
      },
    });
    assert.equal(result.winner, "candidate 2");
    assert.equal(result.winnerIndex, 1);
    assert.equal(result.ranking[0], 1);
    assert.equal(result.evals, 1);
    assert.equal(result.pivots, 1);
    assert.match(result.runDir, /\.pi\/verify\/candidates\//);
    assert.match(result.trailPath, /\.pi\/verify\/trail\.jsonl$/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      VERIFIER_BASE_URL: originalEnv.base,
      VERIFIER_API_KEY: originalEnv.key,
      VERIFIER_MODEL: originalEnv.model,
      VERIFIER_EVALS: originalEnv.evals,
      VERIFIER_PIVOTS: originalEnv.pivots,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
