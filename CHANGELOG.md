# Changelog

## Unreleased

- Add an optional TypeSafe verifier backend (`VERIFIER_PROVIDER=typesafe`).
- Send `DEEPSEEK_API_KEY` only to `api.deepseek.com`, and `OPENAI_API_KEY` only to
  `api.openai.com` or the `OPENAI_BASE_URL` endpoint. Before, either key could be
  sent to any custom `VERIFIER_BASE_URL`. Use `VERIFIER_API_KEY` for other endpoints.
- Send `thinking: disabled` to DeepSeek when the verifier effort is `off`. Before,
  `off` left DeepSeek's default thinking on. On the benchmark, a verifier with no
  thinking picks no better than random, so `off` is not recommended.
- Add a development-only selection benchmark (`npm run bench`) and a README chart
  of its results.

## 0.1.0-rc.4 - 2026-08-22

- Update the development-only `tsx`/`esbuild` toolchain to resolve GHSA-67mh-4wv8-2f99.

## 0.1.0-rc.3 - 2026-08-22

- Require usable token top-logprobs for both verifier score tags and apply a fixed verifier-request deadline.
- Reuse unordered tournament comparisons, protect local artifacts, and correct artifact-write wording.

## 0.1.0-rc.2 - 2026-08-22

- Add a complete safe `.pi/settings.json` reference and support its candidate,
  token-budget, and DeepSeek-effort values.
- Prevent a project setting from authorizing a stored credential for a custom
  verifier endpoint.

## 0.1.0-rc.1 - 2026-08-22

- Add the `self_verify` Pi tool, `/self-verify` command, and workflow skill.
- Generate read-only best-of-N candidates and rank them with fine-grained
  logprob scoring and a probabilistic pivot tournament.
- Support DeepSeek, Vertex Gemini, OpenAI-compatible hosted providers, and
  local vLLM/SGLang endpoints.
- Persist candidates, winners, scores, and trail artifacts under `.pi/verify/`.
