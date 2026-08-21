# Changelog

## 0.1.0-rc.1 - 2026-08-22

- Add the `self_verify` Pi tool, `/self-verify` command, and workflow skill.
- Generate read-only best-of-N candidates and rank them with fine-grained
  logprob scoring and a probabilistic pivot tournament.
- Support DeepSeek, Vertex Gemini, OpenAI-compatible hosted providers, and
  local vLLM/SGLang endpoints.
- Persist candidates, winners, scores, and trail artifacts under `.pi/verify/`.
