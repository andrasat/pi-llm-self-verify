---
name: self-verify
description: >-
  Generate independent candidate solutions and select the strongest one with a
  fine-grained logprob verifier. Use for high-stakes or ambiguous tasks, or
  when the user asks to self-verify or pick the best solution.
---

# Self-Verify

Use the `self_verify` tool for a best-of-N selection pass before implementing a
high-stakes task. It generates candidates with read-only pi subprocesses, then
scores them through a verifier backend that returns token logprobs. The
backend can be DeepSeek, Vertex Gemini, or any compatible OpenAI-style endpoint.

The result is advisory. The winning candidate still needs normal inspection,
implementation, tests, and independent review. Self-verify is never a release
gate and never authorizes committing, pushing, or closing an issue by itself.

## Defaults

- 3 candidates
- 2 repeated evaluations per criterion
- 1 tournament pivot
- correctness and verification criteria

Use `/self-verify <task>` to run it directly. With no argument, the command
uses the most recent user task when one is available.

## Verifier setup

Choose one backend:

- DeepSeek: `/login deepseek` or `DEEPSEEK_API_KEY`; default model `deepseek-v4-flash`.
- OpenAI-compatible: set `VERIFIER_BASE_URL`, `VERIFIER_MODEL`, and
  `VERIFIER_API_KEY` for OpenAI, Together, Cerebras, OpenRouter, Fireworks,
  vLLM, or SGLang.
- Vertex Gemini: set `VERIFIER_PROVIDER=vertex`, `VERIFIER_MODEL=gemini-2.5-flash`,
  `GOOGLE_CLOUD_PROJECT`, and either `VERTEX_API_KEY` or ADC.

Useful controls:

- `VERIFIER_TOP_LOGPROBS` (`1`-`20`, default `20`; use `5` for many Fireworks deployments)
- `VERIFIER_MAX_TOKENS`
- `VERIFIER_EVALS` and `VERIFIER_PIVOTS`
- `VERIFIER_AUTH_PROVIDER` for an explicitly selected Pi API-key credential

Non-secret `verify` settings are `candidates`, `evals`, `pivots`, `model`,
`provider`, `topLogprobs`, `maxTokens`, `effort`, `project`, `location`, and
`thinkingBudget`; see the README for the complete JSON template. Endpoint,
auth-provider, and credential values stay in Pi auth or the environment. The
selected model must return token-level logprobs and top alternatives; a normal
text judge is not equivalent.

Every run stores its problem, candidates, winner, and scores under
`.pi/verify/`. These artifacts can contain sensitive task text; keep them
ignored or disable/clean them according to your project's data policy.
