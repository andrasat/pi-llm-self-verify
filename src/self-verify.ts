import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const DEFAULT_CRITERIA: Record<string, string> = {
  Correctness: "Does the candidate correctly and completely solve the task?",
  Verification: "Does the candidate include appropriate validation or tests?",
};

const DEFAULT_CANDIDATES = 3;
const DEFAULT_EVALS = 2;
const DEFAULT_PIVOTS = 1;
const MAX_CANDIDATES = 5;
const CANDIDATE_CONCURRENCY = 2;
const MAX_CRITERIA = 4;
const MAX_TEXT = 50_000;
const DEFAULT_TOP_LOGPROBS = 20;
const MAX_TOP_LOGPROBS = 20;
const VERIFIER_REQUEST_TIMEOUT_MS = 5 * 60_000;
const SCORE_TAGS = ["<score_A>", "<score_B>"] as const;

type JsonObject = Record<string, unknown>;

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface CommandRunner {
  (command: string, args: string[], options?: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
  }): Promise<CommandResult>;
}

export interface VerifyOptions {
  cwd: string;
  task: string;
  criteria?: Record<string, string> | string[];
  candidateCount?: number;
  candidateModel?: string;
  verifierModel?: string;
  verifierProvider?: string;
  topLogprobs?: number;
  evals?: number;
  pivots?: number;
  signal?: AbortSignal;
  runCommand: CommandRunner;
  onProgress?: (message: string) => void;
}

export interface SelectionResult {
  winner: string;
  winnerIndex: number;
  candidates: string[];
  ranking: number[];
  scores: number[];
  model: string;
  evals: number;
  pivots: number;
  runDir: string;
  trailPath: string;
}

export interface Criterion {
  name: string;
  description: string;
}

interface VerifierConfig {
  backend: "openai" | "vertex";
  provider: string;
  model: string;
  url: string;
  apiKey?: string;
  accessToken?: string;
  maxTokens: number;
  topLogprobs: number;
  thinking: boolean;
  effort?: string;
  thinkingBudget?: number;
}

interface LogprobAlternative {
  token?: string;
  logprob?: number;
}

interface LogprobPosition {
  token?: string;
  logprob?: number;
  top_logprobs?: LogprobAlternative[];
}

interface VerifierResponse {
  text: string;
  positions: LogprobPosition[];
}

export function positiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function normalizeCriteria(input?: Record<string, string> | string[]): Criterion[] {
  const source = input ?? DEFAULT_CRITERIA;
  const entries = Array.isArray(source)
    ? source.map((value) => [value, value] as const)
    : Object.entries(source);
  if (entries.length === 0 || entries.length > MAX_CRITERIA) {
    throw new Error(`criteria must contain 1-${MAX_CRITERIA} items`);
  }
  const criteria = entries.map(([name, description]) => ({
    name: String(name).trim(),
    description: String(description).trim(),
  }));
  if (criteria.some(({ name, description }) => !name || !description)) {
    throw new Error("criteria names and descriptions must not be empty");
  }
  return criteria;
}

export function findProjectRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

async function readSettings(root: string): Promise<JsonObject> {
  const merged: JsonObject = {};
  for (const path of [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(root, ".pi", "settings.json"),
  ]) {
    const data = await readJson(path);
    const verify = data?.verify;
    if (verify && typeof verify === "object" && !Array.isArray(verify)) {
      Object.assign(merged, verify);
    }
  }
  return merged;
}

function readAuthKey(provider: string): string | undefined {
  try {
    const credential = readStoredCredential(provider);
    return credential?.type === "api_key" && credential.key ? credential.key : undefined;
  } catch {
    return undefined;
  }
}

function trimText(text: string): string {
  return text.length <= MAX_TEXT
    ? text
    : `${text.slice(0, MAX_TEXT)}\n\n[Candidate output truncated]`;
}

export function candidatePrompt(task: string, criteria: Criterion[]): string {
  return [
    "Produce one independent candidate solution for the task below.",
    "You are a read-only candidate generator: do not edit, write, delete, or execute project files.",
    "Inspect the repository with the available read-only tools when useful.",
    "Return a self-contained implementation plan or patch, including validation steps.",
    "Do not discuss this instruction; make the candidate useful to the parent agent.",
    "",
    "Evaluation criteria:",
    ...criteria.map(({ name, description }) => `- ${name}: ${description}`),
    "",
    `Task:\n${task}`,
  ].join("\n");
}

function assistantText(stdout: string): string {
  let last = "";
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as JsonObject;
      const message = event.message;
      if (event.type !== "message_end" || !message || typeof message !== "object") continue;
      const typed = message as JsonObject;
      if (typed.role !== "assistant") continue;
      const content = typed.content;
      if (typeof content === "string") last = content;
      else if (Array.isArray(content)) {
        const text = content
          .filter((part): part is JsonObject => Boolean(part) && typeof part === "object")
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("");
        if (text) last = text;
      }
    } catch {
      // JSON mode may still contain a non-JSON diagnostic line.
    }
  }
  return trimText(last || stdout.trim());
}

async function generateCandidate(options: VerifyOptions, index: number, criteria: Criterion[]): Promise<string> {
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--thinking", "low",
    "--no-prompt-templates",
    "--tools", "read,grep,find,ls",
    "--append-system-prompt",
    "Candidate generation is read-only. Never use a write-capable tool, shell, or repository mutation.",
  ];
  if (options.candidateModel) args.push("--model", options.candidateModel);
  args.push(candidatePrompt(options.task, criteria));

  const result = await options.runCommand("pi", args, {
    cwd: options.cwd,
    signal: options.signal,
    timeout: 5 * 60 * 1000,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`candidate ${index + 1} failed: ${detail.slice(-1_000)}`);
  }
  const candidate = assistantText(result.stdout);
  if (!candidate) throw new Error(`candidate ${index + 1} returned no solution`);
  return candidate;
}

function secureUrl(value: string, label: string, allowLocal = false): string {
  const url = new URL(value);
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && local.has(url.hostname))) {
    throw new Error(`${label} must use HTTPS${allowLocal ? " (HTTP is allowed only for localhost)" : ""}`);
  }
  return value.replace(/\/+$/, "");
}

function endpoint(baseUrl: string): string {
  const clean = secureUrl(baseUrl, "verifier endpoint", true);
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function isVertexProvider(provider: string | undefined): boolean {
  return ["vertex", "vertex-ai", "google-vertex", "gemini"].includes((provider || "").toLowerCase());
}

function compatibleProvider(baseUrl: string | undefined, model: string): string {
  if (baseUrl) {
    const host = new URL(baseUrl).hostname;
    if (host.includes("together")) return "together";
    if (host.includes("cerebras")) return "cerebras";
    if (host.includes("fireworks")) return "fireworks";
    if (host.includes("openrouter")) return "openrouter";
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "api.openai.com") return "openai";
  }
  if (model.startsWith("deepseek")) return "deepseek";
  return model.includes("/") ? model.split("/", 1)[0].toLowerCase() : "openai";
}

async function vertexAccessToken(options: VerifyOptions): Promise<string | undefined> {
  const configured = process.env.VERTEX_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (configured) return configured;
  const result = await options.runCommand("gcloud", ["auth", "application-default", "print-access-token"], {
    cwd: options.cwd,
    signal: options.signal,
    timeout: 10_000,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function vertexEndpoint(model: string, settings: JsonObject): string {
  const configured = process.env.VERTEX_BASE_URL;
  if (configured) return secureUrl(configured, "Vertex endpoint");
  const project = process.env.GOOGLE_CLOUD_PROJECT
    || process.env.VERTEX_PROJECT
    || (typeof settings.project === "string" ? settings.project : undefined);
  if (!project) throw new Error("set GOOGLE_CLOUD_PROJECT for Vertex AI");
  const location = process.env.GOOGLE_CLOUD_LOCATION
    || process.env.VERTEX_LOCATION
    || (typeof settings.location === "string" ? settings.location : undefined)
    || "global";
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

async function verifierConfig(root: string, options: VerifyOptions, settings?: JsonObject): Promise<VerifierConfig> {
  const effectiveSettings = settings || await readSettings(root);
  const effectiveModel = options.verifierModel
    || process.env.VERIFIER_MODEL
    || (typeof effectiveSettings.model === "string" ? effectiveSettings.model : undefined)
    || "deepseek-v4-flash";
  const explicitBase = process.env.VERIFIER_BASE_URL || process.env.OPENAI_BASE_URL;
  const requestedProvider = options.verifierProvider
    || process.env.VERIFIER_PROVIDER
    || (typeof effectiveSettings.provider === "string" ? effectiveSettings.provider : undefined);
  const backend = isVertexProvider(requestedProvider)
    || (!requestedProvider && !explicitBase && effectiveModel.startsWith("gemini-"))
    ? "vertex" : "openai";
  const topLogprobs = positiveInt(
    options.topLogprobs ?? process.env.VERIFIER_TOP_LOGPROBS ?? effectiveSettings.topLogprobs,
    "topLogprobs",
    DEFAULT_TOP_LOGPROBS,
  );
  if (topLogprobs > MAX_TOP_LOGPROBS) throw new Error(`topLogprobs must be between 1 and ${MAX_TOP_LOGPROBS}`);
  const maxTokens = positiveInt(
    process.env.VERIFIER_MAX_TOKENS
      || (effectiveModel.startsWith("deepseek") ? process.env.DEEPSEEK_MAX_TOKENS : undefined)
      || effectiveSettings.maxTokens,
    "maxTokens",
    effectiveModel.startsWith("deepseek") ? 32_768 : 4_096,
  );

  if (backend === "vertex") {
    const model = effectiveModel.includes("/") ? effectiveModel.split("/").at(-1)! : effectiveModel;
    if (!model.startsWith("gemini-")) throw new Error("Vertex verifier models must be named gemini-*");
    const apiKey = process.env.VERTEX_API_KEY || process.env.GOOGLE_API_KEY;
    const accessToken = apiKey ? undefined : await vertexAccessToken(options);
    if (!apiKey && !accessToken) {
      throw new Error("set VERTEX_API_KEY or configure Application Default Credentials with gcloud");
    }
    const thinkingBudget = nonNegativeInt(
      process.env.VERTEX_THINKING_BUDGET ?? effectiveSettings.thinkingBudget,
      "VERTEX_THINKING_BUDGET",
      0,
    );
    return {
      backend,
      provider: "vertex",
      model,
      url: vertexEndpoint(model, effectiveSettings),
      apiKey,
      accessToken,
      maxTokens,
      topLogprobs,
      thinking: thinkingBudget > 0,
      thinkingBudget,
    };
  }

  const baseUrl = explicitBase
    || (effectiveModel.startsWith("deepseek") ? "https://api.deepseek.com" : "");
  if (!baseUrl) {
    throw new Error("set VERIFIER_BASE_URL or OPENAI_BASE_URL for an OpenAI-compatible logprob endpoint");
  }
  const inferredProvider = compatibleProvider(explicitBase, effectiveModel);
  // Only an environment value may authorize sending a stored key to a custom endpoint.
  const explicitAuthProvider = process.env.VERIFIER_AUTH_PROVIDER;
  const authProvider = explicitAuthProvider || inferredProvider;
  const expectedHosts: Record<string, string[]> = {
    deepseek: ["api.deepseek.com"],
    openai: ["api.openai.com"],
    together: ["api.together.xyz"],
    cerebras: ["api.cerebras.ai"],
    fireworks: ["api.fireworks.ai"],
    openrouter: ["openrouter.ai"],
  };
  const storedKeyAllowed = !explicitBase
    || Boolean(explicitAuthProvider)
    || (expectedHosts[authProvider] || []).includes(new URL(explicitBase).hostname);
  // Provider keys go only to their own host; OPENAI_API_KEY also pairs with OPENAI_BASE_URL.
  const host = new URL(baseUrl).hostname;
  const openAIKeyAllowed = expectedHosts.openai.includes(host)
    || (!process.env.VERIFIER_BASE_URL && Boolean(process.env.OPENAI_BASE_URL));
  const apiKey = process.env.VERIFIER_API_KEY
    || (openAIKeyAllowed ? process.env.OPENAI_API_KEY : undefined)
    || (expectedHosts.deepseek.includes(host) ? process.env.DEEPSEEK_API_KEY : undefined)
    || (storedKeyAllowed ? readAuthKey(authProvider) : undefined);
  if (effectiveModel.startsWith("deepseek") && !apiKey) {
    throw new Error("no verifier API key (set VERIFIER_API_KEY, DEEPSEEK_API_KEY, or Pi /login deepseek)");
  }
  const configuredEffort = typeof effectiveSettings.effort === "string"
    ? effectiveSettings.effort : undefined;
  const effort = effectiveModel.startsWith("deepseek")
    ? process.env.DEEPSEEK_EFFORT || configuredEffort || "high"
    : process.env.DEEPSEEK_EFFORT || configuredEffort;
  const provider = (requestedProvider || compatibleProvider(explicitBase, effectiveModel)).toLowerCase();
  return {
    backend,
    provider,
    model: effectiveModel,
    url: endpoint(baseUrl),
    apiKey,
    maxTokens,
    topLogprobs,
    thinking: !["off", "disabled", "none"].includes((effort || "high").toLowerCase()),
    effort,
  };
}

async function jsonResponse(response: Response, label: string): Promise<JsonObject> {
  const raw = await response.text();
  let data: JsonObject;
  try {
    data = JSON.parse(raw) as JsonObject;
  } catch {
    throw new Error(`${label} returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    const message = typeof data.error === "object" && data.error
      ? JSON.stringify(data.error)
      : raw;
    throw new Error(`${label} request failed (${response.status}): ${message.slice(0, 500)}`);
  }
  return data;
}

async function callOpenAI(config: VerifierConfig, prompt: string, signal?: AbortSignal): Promise<VerifierResponse> {
  const body: JsonObject = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: config.maxTokens,
    temperature: 1,
    logprobs: config.provider === "together" ? 1 : true,
    top_logprobs: config.topLogprobs,
  };
  if (config.model.startsWith("deepseek")) {
    // DeepSeek thinks by default, so "off" must be sent explicitly.
    body.thinking = { type: config.thinking ? "enabled" : "disabled" };
    if (config.thinking && config.effort) body.reasoning_effort = config.effort;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  const data = await jsonResponse(response, "verifier");
  const choices = data.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const message = choice && typeof choice === "object" ? (choice as JsonObject).message : undefined;
  const text = message && typeof message === "object" && typeof (message as JsonObject).content === "string"
    ? (message as JsonObject).content as string
    : "";
  const logprobs = choice && typeof choice === "object" ? (choice as JsonObject).logprobs : undefined;
  const positions = logprobs && typeof logprobs === "object" && Array.isArray((logprobs as JsonObject).content)
    ? (logprobs as JsonObject).content as LogprobPosition[]
    : [];
  return { text, positions };
}

async function callVertex(config: VerifierConfig, prompt: string, signal?: AbortSignal): Promise<VerifierResponse> {
  const generationConfig: JsonObject = {
    temperature: 1,
    maxOutputTokens: config.maxTokens,
    responseLogprobs: true,
    logprobs: config.topLogprobs,
    ...(config.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: config.thinkingBudget } } : {}),
  };
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { "x-goog-api-key": config.apiKey } : {}),
      ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
    signal,
    redirect: "error",
  });
  const data = await jsonResponse(response, "Vertex verifier");
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
  if (!candidate || typeof candidate !== "object") throw new Error("Vertex verifier returned no candidate");
  const candidateObject = candidate as JsonObject;
  const content = candidateObject.content;
  const parts: unknown[] = content && typeof content === "object" && Array.isArray((content as JsonObject).parts)
    ? (content as JsonObject).parts as unknown[] : [];
  const text = parts
    .filter((part): part is JsonObject => Boolean(part) && typeof part === "object")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  const result = candidateObject.logprobsResult;
  const topCandidates: unknown[] = result && typeof result === "object" && Array.isArray((result as JsonObject).topCandidates)
    ? (result as JsonObject).topCandidates as unknown[] : [];
  const chosenCandidates: unknown[] = result && typeof result === "object" && Array.isArray((result as JsonObject).chosenCandidates)
    ? (result as JsonObject).chosenCandidates as unknown[] : [];
  const positions = topCandidates.map((entry, index): LogprobPosition => {
    const top: unknown[] = entry && typeof entry === "object" && Array.isArray((entry as JsonObject).candidates)
      ? (entry as JsonObject).candidates as unknown[] : [];
    const chosen = chosenCandidates[index];
    return {
      token: chosen && typeof chosen === "object" && typeof (chosen as JsonObject).token === "string"
        ? (chosen as JsonObject).token as string : undefined,
      logprob: chosen && typeof chosen === "object" && typeof (chosen as JsonObject).logProbability === "number"
        ? (chosen as JsonObject).logProbability as number : undefined,
      top_logprobs: top
        .filter((item): item is JsonObject => Boolean(item) && typeof item === "object")
        .map((item) => ({
          token: typeof item.token === "string" ? item.token : undefined,
          logprob: typeof item.logProbability === "number" ? item.logProbability : undefined,
        })),
    };
  });
  return { text, positions };
}

async function callVerifier(
  config: VerifierConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<VerifierResponse> {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(VERIFIER_REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  return config.backend === "vertex"
    ? callVertex(config, prompt, requestSignal)
    : callOpenAI(config, prompt, requestSignal);
}

function scoreAtTag(positions: LogprobPosition[], tag: string): number {
  let tokenText = "";
  let distribution: LogprobAlternative[] | undefined;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    tokenText += position.token || "";
    if (!position.token?.trim()) continue;
    if ((tokenText.trimEnd().endsWith(tag) || tokenText.trimEnd().endsWith(tag.slice(0, -1))) && positions[index + 1]) {
      distribution = positions[index + 1].top_logprobs;
    }
  }

  const values = new Map<number, number>();
  for (const alternative of distribution || []) {
    const token = (alternative.token || "").trim().replace(/^>/, "");
    const logprob = alternative.logprob;
    if (!/^[A-T]$/i.test(token) || typeof logprob !== "number" || !Number.isFinite(logprob)) continue;
    const probability = Math.exp(logprob);
    if (!Number.isFinite(probability) || probability <= 0) continue;
    const value = 20 - (token.toUpperCase().charCodeAt(0) - 65);
    values.set(value, Math.max(values.get(value) || 0, probability));
  }
  if (values.size) {
    let total = 0;
    let expected = 0;
    for (const [value, probability] of values) {
      total += probability;
      expected += value * probability;
    }
    return (expected / total - 1) / 19;
  }
  throw new Error(`verifier response did not include usable token top_logprobs for ${tag}`);
}

export function scoreResponse(response: VerifierResponse): [number, number] {
  return [
    scoreAtTag(response.positions, SCORE_TAGS[0]),
    scoreAtTag(response.positions, SCORE_TAGS[1]),
  ];
}

export function ringPairs(count: number, random: () => number = Math.random): [number, number][] {
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order.map((value, index) => [value, order[(index + 1) % order.length]]);
}

export function pivotPairs(count: number, pivots: number[]): [number, number][] {
  const pivotSet = new Set(pivots);
  const pairs: [number, number][] = [];
  for (let candidate = 0; candidate < count; candidate += 1) {
    if (!pivotSet.has(candidate)) {
      for (const pivot of pivots) pairs.push([candidate, pivot]);
    }
  }
  for (let left = 0; left < pivots.length; left += 1) {
    for (let right = left + 1; right < pivots.length; right += 1) {
      pairs.push([Math.min(pivots[left], pivots[right]), Math.max(pivots[left], pivots[right])]);
    }
  }
  return pairs;
}

export function rankFromPairs(
  count: number,
  ring: [number, number][],
  pivotCount: number,
  score: (a: number, b: number) => [number, number],
): { winnerIndex: number; ranking: number[]; scores: number[] } {
  const wins = Array.from({ length: count }, () => 0);
  const comparisons = Array.from({ length: count }, () => 0);
  const accumulate = (pairs: [number, number][]) => {
    for (const [a, b] of pairs) {
      const [scoreA, scoreB] = score(a, b);
      const probability = 1 / (1 + Math.exp(-(scoreA - scoreB)));
      wins[a] += probability;
      wins[b] += 1 - probability;
      comparisons[a] += 1;
      comparisons[b] += 1;
    }
  };
  accumulate(ring);
  const pivots = Array.from({ length: count }, (_, index) => index)
    .sort((a, b) => (wins[b] / comparisons[b] || 0) - (wins[a] / comparisons[a] || 0) || a - b)
    .slice(0, Math.min(pivotCount, count));
  accumulate(pivotPairs(count, pivots));
  const scores = wins.map((win, index) => win / comparisons[index]);
  const ranking = Array.from({ length: count }, (_, index) => index)
    .sort((a, b) => scores[b] - scores[a] || a - b);
  return { winnerIndex: ranking[0], ranking, scores };
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function secureWrite(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function secureAppend(path: string, data: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(path, data, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function orientScore(score: [number, number], a: number, b: number): [number, number] {
  return a < b ? score : [score[1], score[0]];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function pairPrompt(task: string, a: string, b: string, criterion: Criterion): string {
  return [
    "You are an expert evaluator of AI coding agents.",
    "Evaluate two candidate solutions on one criterion only.",
    `Task:\n${task}`,
    `Trajectory A:\n${a}`,
    `Trajectory B:\n${b}`,
    "Rating scale: A is the best score and T is the worst score.",
    "Use every letter A through T for fine-grained confidence.",
    `Criterion — ${criterion.name}: ${criterion.description}`,
    "Reason first, then end with exactly these lines and nothing after them:",
    "<score_A> LETTER_A_TO_T </score_A>",
    "<score_B> LETTER_A_TO_T </score_B>",
  ].join("\n\n");
}

async function compare(
  config: VerifierConfig,
  options: VerifyOptions,
  task: string,
  candidates: string[],
  a: number,
  b: number,
  criteria: Criterion[],
  evals: number,
): Promise<[number, number]> {
  let totalA = 0;
  let totalB = 0;
  let count = 0;
  for (const criterion of criteria) {
    for (let repetition = 0; repetition < evals; repetition += 1) {
      const swapped = repetition % 2 === 1;
      const response = await callVerifier(
        config,
        pairPrompt(task, swapped ? candidates[b] : candidates[a], swapped ? candidates[a] : candidates[b], criterion),
        options.signal,
      );
      const [first, second] = scoreResponse(response);
      totalA += swapped ? second : first;
      totalB += swapped ? first : second;
      count += 1;
    }
  }
  return [totalA / count, totalB / count];
}

export async function runSelfVerify(options: VerifyOptions): Promise<SelectionResult> {
  if (!options.task.trim()) throw new Error("task must not be empty");
  const root = findProjectRoot(options.cwd);
  const criteria = normalizeCriteria(options.criteria);
  const settings = await readSettings(root);
  const candidateCount = positiveInt(options.candidateCount ?? settings.candidates, "candidateCount", DEFAULT_CANDIDATES);
  const evals = positiveInt(options.evals ?? process.env.VERIFIER_EVALS ?? settings.evals, "evals", DEFAULT_EVALS);
  const pivots = positiveInt(options.pivots ?? process.env.VERIFIER_PIVOTS ?? settings.pivots, "pivots", DEFAULT_PIVOTS);
  if (candidateCount < 2 || candidateCount > MAX_CANDIDATES) {
    throw new Error(`candidateCount must be between 2 and ${MAX_CANDIDATES}`);
  }
  if (pivots > candidateCount) throw new Error("pivots cannot exceed candidateCount");

  const config = await verifierConfig(root, options, settings);
  const verifyDir = join(root, ".pi", "verify");
  const candidatesDir = join(verifyDir, "candidates");
  const runDir = join(candidatesDir, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  const trailPath = join(verifyDir, "trail.jsonl");
  await secureDirectory(verifyDir);
  await secureDirectory(candidatesDir);
  await secureDirectory(runDir);
  await secureWrite(join(runDir, "problem.md"), options.task);
  await secureWrite(join(runDir, "criteria.json"), JSON.stringify(Object.fromEntries(criteria.map(({ name, description }) => [name, description])), null, 2));
  options.onProgress?.(`Generating ${candidateCount} read-only candidates...`);

  const candidates = await mapLimit(
    Array.from({ length: candidateCount }, (_, index) => index),
    Math.min(CANDIDATE_CONCURRENCY, candidateCount),
    async (index) => {
      options.onProgress?.(`Generating candidate ${index + 1}/${candidateCount}...`);
      const candidate = await generateCandidate(options, index, criteria);
      options.onProgress?.(`Candidate ${index + 1}/${candidateCount} ready.`);
      return candidate;
    },
  );
  await Promise.all(candidates.map((candidate, index) => secureWrite(join(runDir, `cand_${index + 1}.md`), candidate)));

  const cache = new Map<string, [number, number]>();
  const inFlight = new Map<string, Promise<[number, number]>>();
  const scorePair = async (a: number, b: number): Promise<[number, number]> => {
    const key = pairKey(a, b);
    const existing = cache.get(key);
    if (existing) return orientScore(existing, a, b);
    let pending = inFlight.get(key);
    if (!pending) {
      const [left, right] = a < b ? [a, b] : [b, a];
      pending = compare(config, options, options.task, candidates, left, right, criteria, evals)
        .then((score) => {
          cache.set(key, score);
          return score;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return orientScore(await pending, a, b);
  };
  const runPairs = async (pairs: [number, number][]) => mapLimit(pairs, 8, ([a, b]) => scorePair(a, b));
  options.onProgress?.(`Scoring candidates with ${config.model}...`);
  const ring = ringPairs(candidateCount);
  await runPairs(ring);
  const ringLookup = new Map(ring.map(([a, b]) => [pairKey(a, b), cache.get(pairKey(a, b))!]));
  // Select pivots from the ring pass only; pivot-round scores do not exist yet.
  const ringRanking = rankFromPairs(candidateCount, ring, 0, (a, b) => {
    const score = ringLookup.get(pairKey(a, b));
    return score ? orientScore(score, a, b) : [0.5, 0.5];
  });
  const pivotSet = ringRanking.ranking.slice(0, Math.min(pivots, candidateCount));
  const extraPairs = pivotPairs(candidateCount, pivotSet).filter(([a, b]) => !ringLookup.has(pairKey(a, b)));
  await runPairs(extraPairs);
  const selected = rankFromPairs(candidateCount, ring, pivots, (a, b) => {
    const score = cache.get(pairKey(a, b));
    return score ? orientScore(score, a, b) : [0.5, 0.5];
  });
  const winner = candidates[selected.winnerIndex];
  await secureWrite(join(runDir, "winner.md"), winner);

  const entry = {
    timestamp: new Date().toISOString(),
    project: basename(root),
    model: config.model,
    evals,
    pivots,
    criteria: Object.fromEntries(criteria.map(({ name, description }) => [name, description])),
    problem: options.task,
    candidates,
    scores: Object.fromEntries(selected.scores.map((score, index) => [`cand_${index + 1}`, Number(score.toFixed(4))])),
    winnerIndex: selected.winnerIndex,
    ranking: selected.ranking.map((index) => `cand_${index + 1}`),
  };
  await secureDirectory(dirname(trailPath));
  await secureAppend(trailPath, `${JSON.stringify(entry)}\n`);

  return {
    winner,
    winnerIndex: selected.winnerIndex,
    candidates,
    ranking: selected.ranking,
    scores: selected.scores,
    model: config.model,
    evals,
    pivots,
    runDir,
    trailPath,
  };
}

export function formatSelection(result: SelectionResult): string {
  const ranking = result.ranking
    .map((index, position) => `${position + 1}. cand_${index + 1} (${result.scores[index].toFixed(3)})`)
    .join(", ");
  return [
    `Self-verify selected candidate ${result.winnerIndex + 1}/${result.candidates.length}.`,
    `Verifier: ${result.model}; evaluations: ${result.evals}; pivots: ${result.pivots}.`,
    `Ranking: ${ranking}`,
    "",
    "Winning candidate:",
    result.winner,
    "",
    "This is a selection aid, not an implementation or independent review gate. Check it before editing.",
    `Artifacts: ${result.runDir}`,
  ].join("\n");
}

export function latestUserPrompt(entries: unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as JsonObject).message;
    if (!message || typeof message !== "object" || (message as JsonObject).role !== "user") continue;
    const content = (message as JsonObject).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((part): part is JsonObject => Boolean(part) && typeof part === "object")
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("")
        : "";
    if (text.trim() && !text.trimStart().startsWith("/self-verify")) return text.trim();
  }
  return undefined;
}

export function currentModelName(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}
