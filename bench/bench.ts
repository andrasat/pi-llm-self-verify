// Selection benchmark: does a verifier pick candidates that pass hidden tests?
//
//   npm run bench -- setup               # uv venv with numpy for MBPP+ tests
//   npm run bench -- fetch               # download MBPP+ (378 tasks)
//   npm run bench -- selfcheck           # canonical solutions must pass, a stub must fail
//   npm run bench -- generate [--limit N] # N tasks x BENCH_CANDIDATES candidates (resumable)
//   npm run bench -- label               # run hidden tests on every candidate
//   npm run bench -- select deepseek|typesafe
//   npm run bench -- report
//
// Env: DEEPSEEK_API_KEY, TYPESAFE_API_KEY, BENCH_RUN (default "default"),
// BENCH_CANDIDATE_MODEL / VERIFIER_MODEL (default deepseek-flash),
// BENCH_CANDIDATES (default 4), BENCH_CANDIDATE_EFFORT (low|high|max|off, default low),
// TYPESAFE_MODEL (default jev-latest).
//
// Warning: `label` executes model-written Python locally (temp dir, 20s timeout, no sandbox).
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  candidatePrompt,
  DEFAULT_CRITERIA,
  normalizeCriteria,
  runSelfVerify,
  type Criterion,
} from "../src/self-verify.ts";

const run = promisify(execFile);
const BENCH = dirname(fileURLToPath(import.meta.url));
const DATA = join(BENCH, "data", "mbppplus.jsonl");
const EXCLUDED = join(BENCH, "data", "excluded.json");
const RUN_DIR = join(BENCH, "runs", process.env.BENCH_RUN || "default");
const VENV = join(BENCH, ".venv");
const PYTHON = process.platform === "win32" ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
const CANDIDATE_MODEL = process.env.BENCH_CANDIDATE_MODEL || "deepseek-flash";
const VERIFIER_MODEL = process.env.VERIFIER_MODEL || "deepseek-flash";
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const CANDIDATES = Number(process.env.BENCH_CANDIDATES || 4);
const CANDIDATE_EFFORT = process.env.BENCH_CANDIDATE_EFFORT || "low";
const CRITERIA = normalizeCriteria(DEFAULT_CRITERIA);

interface Task { task_id: number; prompt: string; code: string; test_list: string[]; test: string }
interface Usage { input: number; output: number }
interface Selection { task_id: number; winner: number; scores: number[]; ms: number; usage: Usage; error?: string }

// Count tokens for every API call: a phase total, plus an exact per-task total for concurrent tasks.
const usage: Usage = { input: 0, output: 0 };
const taskUsage = new AsyncLocalStorage<Usage>();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  try {
    const data = await response.clone().json() as { usage?: Record<string, number> };
    const input = data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0;
    const output = data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0;
    for (const counter of [usage, taskUsage.getStore()]) {
      if (!counter) continue;
      counter.input += input;
      counter.output += output;
    }
  } catch {
    // Non-JSON bodies carry no usage.
  }
  return response;
};

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function append(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// MBPP convention: the first assert fixes the function name and signature.
function taskText(task: Task): string {
  return `${task.prompt}\nYour code should pass this test:\n${task.test_list[0]}\n`
    + "Return the complete Python solution in one ```python code block.";
}

function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  return blocks.at(-1) ?? text;
}

function isDev(taskId: number): boolean {
  return createHash("sha256").update(String(taskId)).digest()[0] < 77; // ~30% dev split
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

async function setup(): Promise<void> {
  await run("uv", ["venv", VENV, "--python", "3.12"]);
  await run("uv", ["pip", "install", "--python", PYTHON, "numpy"]);
  console.log(`python ready: ${PYTHON}`);
}

async function fetchDataset(): Promise<void> {
  const rows: Task[] = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetch(`https://datasets-server.huggingface.co/rows?dataset=evalplus/mbppplus&config=default&split=test&offset=${offset}&length=100`);
    if (!response.ok) throw new Error(`dataset fetch failed (${response.status})`);
    const page = await response.json() as { rows: { row: Task }[] };
    rows.push(...page.rows.map(({ row }) => ({ task_id: row.task_id, prompt: row.prompt, code: row.code, test_list: row.test_list, test: row.test })));
    if (page.rows.length < 100) break;
  }
  await mkdir(dirname(DATA), { recursive: true });
  await writeFile(DATA, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(`saved ${rows.length} tasks to ${DATA}`);
}

async function deepseekCandidate(prompt: string): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("set DEEPSEEK_API_KEY");
  // Default mirrors `pi --thinking low`; "off" makes weaker candidates so more tasks are mixed.
  const thinking = CANDIDATE_EFFORT === "off"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: CANDIDATE_EFFORT };
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: CANDIDATE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 1,
      max_tokens: 8_192,
      ...thinking,
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const data = await response.json() as { choices?: { message?: { content?: string } }[]; error?: unknown };
  const text = data.choices?.[0]?.message?.content;
  if (!response.ok || !text) throw new Error(`candidate request failed (${response.status}): ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  return text;
}

async function generate(limit: number): Promise<void> {
  if (!existsSync(EXCLUDED)) throw new Error("run `npm run bench -- selfcheck` first");
  const excluded = new Set(JSON.parse(await readFile(EXCLUDED, "utf8")) as number[]);
  const tasks = (await readJsonl<Task>(DATA)).filter((task) => !excluded.has(task.task_id)).slice(0, limit);
  const path = join(RUN_DIR, "candidates.jsonl");
  const done = new Set((await readJsonl<{ task_id: number }>(path)).map((row) => row.task_id));
  const todo = tasks.filter((task) => !done.has(task.task_id));
  let finished = 0;
  await mapLimit(todo, 8, async (task) => {
    try {
      const prompt = candidatePrompt(taskText(task), CRITERIA);
      const candidates = await Promise.all(Array.from({ length: CANDIDATES }, () => deepseekCandidate(prompt)));
      await append(path, { task_id: task.task_id, candidates });
    } catch (error) {
      console.error(`task ${task.task_id}: ${(error as Error).message}`);
    }
    finished += 1;
    if (finished % 10 === 0) console.log(`generated ${finished}/${todo.length}`);
  });
  console.log(`candidates: ${path}; tokens in=${usage.input} out=${usage.output}`);
}

async function passes(task: Task, code: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "mbpp-"));
  try {
    await writeFile(join(dir, "run.py"), `${code}\n\n${task.test}\n`);
    await run(PYTHON, ["-I", "run.py"], { cwd: dir, timeout: 20_000, maxBuffer: 1 << 20 });
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Harness check: every canonical solution passes its hidden tests and a stub fails them.
async function selfcheck(): Promise<void> {
  if (!existsSync(PYTHON)) throw new Error("run `npm run bench -- setup` first");
  const tasks = await readJsonl<Task>(DATA);
  const failed: number[] = [];
  await mapLimit(tasks, 8, async (task) => {
    const name = /def\s+(\w+)/.exec(task.code)?.[1] ?? "missing";
    const canonical = await passes(task, extractCode("Solution:\n```python\n" + task.code + "\n```"));
    const stub = await passes(task, `def ${name}(*args, **kwargs):\n    return None\n`);
    if (!canonical || stub) failed.push(task.task_id);
  });
  // Tasks whose canonical fails or whose stub passes cannot label candidates; generate skips them.
  await writeFile(EXCLUDED, JSON.stringify(failed.sort((a, b) => a - b)));
  console.log(`selfcheck: ${tasks.length - failed.length}/${tasks.length} ok${failed.length ? `; excluded: ${failed.join(", ")}` : ""}`);
}

async function label(): Promise<void> {
  if (!existsSync(PYTHON)) throw new Error("run `npm run bench -- setup` first");
  const tasks = new Map((await readJsonl<Task>(DATA)).map((task) => [task.task_id, task]));
  const path = join(RUN_DIR, "labels.jsonl");
  const done = new Set((await readJsonl<{ task_id: number }>(path)).map((row) => row.task_id));
  const rows = (await readJsonl<{ task_id: number; candidates: string[] }>(join(RUN_DIR, "candidates.jsonl")))
    .filter((row) => !done.has(row.task_id));
  await mapLimit(rows, 8, async (row) => {
    const task = tasks.get(row.task_id)!;
    const pass = await Promise.all(row.candidates.map((text) => passes(task, extractCode(text))));
    await append(path, { task_id: row.task_id, pass });
  });
  const labels = await readJsonl<{ pass: boolean[] }>(path);
  const mixed = labels.filter(({ pass }) => pass.some(Boolean) && !pass.every(Boolean)).length;
  console.log(`labeled ${labels.length} tasks; mixed (selectable) ${mixed}`);
}

const LEVELS = [
  "Fails the criterion",
  "Partly meets the criterion, with significant gaps or bugs",
  "Mostly meets the criterion, with minor gaps",
  "Fully meets the criterion",
];

// Prototype of the proposed backend: one request per candidate, one Score per criterion.
async function typesafeScore(task: string, candidate: string, criteria: Criterion[]): Promise<number> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("set TYPESAFE_API_KEY");
  const questions = Object.fromEntries(criteria.map(({ name, description }, index) => [`c${index}`, {
    type: "score",
    instructions: {
      criterion: `${name}: ${description}`,
      question: "How well does `candidate_solution` meet `criterion` for `task`? Check the code against what `task` asks.",
    },
    criteria: LEVELS,
  }]));
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: TYPESAFE_MODEL, state: { task, candidate_solution: candidate }, questions }),
      redirect: "error",
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if ((response.status === 429 || response.status === 529) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    const data = await response.json() as { answers?: Record<string, { score: number }> };
    if (!response.ok || !data.answers) throw new Error(`TypeSafe request failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    const scores = criteria.map((_, index) => data.answers![`c${index}`].score / (LEVELS.length - 1));
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
}

async function selectTypesafe(task: string, candidates: string[]): Promise<{ winner: number; scores: number[] }> {
  const scores = await Promise.all(candidates.map((candidate) => typesafeScore(task, candidate, CRITERIA)));
  return { winner: scores.indexOf(Math.max(...scores)), scores };
}

// Production verifier path: real runSelfVerify, with `pi` replaced by the stored candidates.
async function selectDeepseek(task: string, candidates: string[], workspace: string): Promise<{ winner: number; scores: number[] }> {
  let call = 0;
  const result = await runSelfVerify({
    cwd: workspace,
    task,
    candidateCount: candidates.length,
    verifierModel: VERIFIER_MODEL,
    // Production defaults, pinned so local Pi settings cannot change the baseline.
    evals: 2,
    pivots: 1,
    topLogprobs: 20,
    runCommand: async () => {
      const text = candidates[call++];
      const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
      return { stdout: `${JSON.stringify(event)}\n`, stderr: "", code: 0 };
    },
  });
  return { winner: result.winnerIndex, scores: result.scores };
}

async function select(method: string): Promise<void> {
  if (method !== "deepseek" && method !== "typesafe") throw new Error("select deepseek|typesafe");
  const tasks = new Map((await readJsonl<Task>(DATA)).map((task) => [task.task_id, task]));
  const labels = new Map((await readJsonl<{ task_id: number; pass: boolean[] }>(join(RUN_DIR, "labels.jsonl")))
    .map((row) => [row.task_id, row.pass]));
  const path = join(RUN_DIR, `select-${method}.jsonl`);
  const done = new Set((await readJsonl<Selection>(path)).filter((row) => !row.error).map((row) => row.task_id));
  const rows = (await readJsonl<{ task_id: number; candidates: string[] }>(join(RUN_DIR, "candidates.jsonl")))
    .filter((row) => {
      const pass = labels.get(row.task_id);
      return pass && pass.some(Boolean) && !pass.every(Boolean) && !done.has(row.task_id);
    });
  const workspace = await mkdtemp(join(tmpdir(), "self-verify-bench-"));
  // Isolate the baseline from local Pi settings and shell overrides.
  process.env.DEEPSEEK_EFFORT ??= "high";
  delete process.env.VERIFIER_EVALS;
  delete process.env.VERIFIER_PIVOTS;
  delete process.env.VERIFIER_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.VERIFIER_PROVIDER;
  let finished = 0;
  await mapLimit(rows, method === "deepseek" ? 4 : 8, async (row) => {
    const task = taskText(tasks.get(row.task_id)!);
    const counted: Usage = { input: 0, output: 0 };
    const started = Date.now();
    let entry: Selection;
    try {
      const picked = await taskUsage.run(counted, () => method === "deepseek"
        ? selectDeepseek(task, row.candidates, workspace)
        : selectTypesafe(task, row.candidates));
      entry = { task_id: row.task_id, ...picked, ms: Date.now() - started, usage: { input: 0, output: 0 } };
    } catch (error) {
      entry = { task_id: row.task_id, winner: -1, scores: [], ms: Date.now() - started, usage: { input: 0, output: 0 }, error: (error as Error).message };
      console.error(`task ${row.task_id}: ${entry.error}`);
    }
    entry.usage = counted;
    await append(path, entry);
    finished += 1;
    if (finished % 10 === 0) console.log(`${method}: ${finished}/${rows.length}`);
  });
  await rm(workspace, { recursive: true, force: true });
  console.log(`${method}: ${rows.length} tasks; tokens in=${usage.input} out=${usage.output}`);
}

function bootstrap(diffs: number[], iterations = 10_000): [number, number] {
  const random = seeded(42);
  const means = Array.from({ length: iterations }, () => {
    let sum = 0;
    for (let index = 0; index < diffs.length; index += 1) sum += diffs[Math.floor(random() * diffs.length)];
    return sum / diffs.length;
  }).sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

async function report(): Promise<void> {
  const labels = new Map((await readJsonl<{ task_id: number; pass: boolean[] }>(join(RUN_DIR, "labels.jsonl")))
    .map((row) => [row.task_id, row.pass]));
  const methods = ["deepseek", "typesafe"];
  const selections = new Map<string, Map<number, Selection>>();
  const failures: string[] = [];
  for (const method of methods) {
    const all = await readJsonl<Selection>(join(RUN_DIR, `select-${method}.jsonl`));
    const rows = all.filter((row) => !row.error);
    selections.set(method, new Map(rows.map((row) => [row.task_id, row])));
    // A task that never succeeded is a verifier failure; it is reported, not silently dropped.
    const ok = new Set(rows.map((row) => row.task_id));
    const failed = [...new Map(all.filter((row) => row.error && !ok.has(row.task_id)).map((row) => [row.task_id, row.error])).entries()];
    failures.push(`${method}: ${failed.length ? failed.map(([id, error]) => `task ${id} (${error})`).join("; ") : "none"}`);
  }
  // Compare only tasks every method answered, so the pairing is exact.
  const ids = [...labels.keys()].filter((id) => methods.every((method) => selections.get(method)!.has(id)));
  const allLabels = [...labels.values()];
  const lines = [
    `# Self-verify selection benchmark (${process.env.BENCH_RUN || "default"})`,
    "",
    `Candidates: ${CANDIDATE_MODEL} (effort ${CANDIDATE_EFFORT}), ${CANDIDATES} per task. Verifier: ${VERIFIER_MODEL}; TypeSafe: ${TYPESAFE_MODEL}. Labeled tasks: ${allLabels.length}; `
      + `all pass: ${allLabels.filter((pass) => pass.every(Boolean)).length}; `
      + `none pass: ${allLabels.filter((pass) => !pass.some(Boolean)).length}; mixed and scored by every method: ${ids.length}.`,
    "",
    `Verifier failures (excluded from the comparison): ${failures.join(" | ")}.`,
    "",
    "Selection pass rate on mixed tasks (random = expected value of a uniform pick, oracle = 1).",
    "",
    "| Split | n | Random | DeepSeek pairwise | TypeSafe pointwise | TypeSafe − DeepSeek (95% CI) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const [split, keep] of [["dev", isDev], ["test", (id: number) => !isDev(id)], ["all", () => true]] as const) {
    const subset = ids.filter(keep);
    if (!subset.length) continue;
    const pick = (method: string, id: number) => Number(labels.get(id)![selections.get(method)!.get(id)!.winner]);
    const random = subset.map((id) => labels.get(id)!.filter(Boolean).length / labels.get(id)!.length);
    const deepseek = subset.map((id) => pick("deepseek", id));
    const typesafe = subset.map((id) => pick("typesafe", id));
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const diffs = typesafe.map((value, index) => value - deepseek[index]);
    const [low, high] = bootstrap(diffs);
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    lines.push(`| ${split} | ${subset.length} | ${pct(mean(random))} | ${pct(mean(deepseek))} | ${pct(mean(typesafe))} | ${pct(mean(diffs))} (${pct(low)} to ${pct(high)}) |`);
  }
  lines.push("", "| Method | Input tokens | Output tokens | Median ms per task |", "| --- | --- | --- | --- |");
  for (const method of methods) {
    const rows = ids.map((id) => selections.get(method)!.get(id)!);
    const ms = rows.map((row) => row.ms).sort((a, b) => a - b);
    const sum = (key: keyof Usage) => rows.reduce((total, row) => total + row.usage[key], 0);
    lines.push(`| ${method} | ${sum("input")} | ${sum("output")} | ${ms[Math.floor(ms.length / 2)] ?? 0} |`);
  }
  const text = `${lines.join("\n")}\n`;
  await writeFile(join(RUN_DIR, "report.md"), text);
  console.log(text);
}

const [command, ...rest] = process.argv.slice(2);
const limitIndex = rest.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
const commands: Record<string, () => Promise<void>> = {
  setup,
  fetch: fetchDataset,
  selfcheck,
  generate: () => generate(limit),
  label,
  select: () => select(rest[0]),
  report,
};
if (!commands[command]) {
  console.error(`usage: npm run bench -- ${Object.keys(commands).join("|")}`);
  process.exit(1);
}
await commands[command]();
