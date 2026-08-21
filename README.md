# pi-llm-self-verify

A Pi package that generates independent, read-only candidate solutions and
selects the strongest one with a fine-grained logprob verifier.

Self-verify is a **selection aid**. It does not edit files, run project tests,
approve changes, replace independent review, or authorize commits and pushes.

## Install

From this repository while developing:

```bash
pi install /absolute/path/to/pi-llm-self-verify
```

From Git after a tagged release:

```bash
pi install git:github.com/andrasat/pi-llm-self-verify@v0.1.0
```

Use `-l` with either command to write the package to the current project's
`.pi/settings.json` instead of the global settings.

Git-tagged installation is the release path; npm publishing is optional:

```bash
npm run check
git add . && git commit -m "Release v0.1.0"
git push origin main
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

Do not publish until the tag and Git installation have been tested in a clean
project. `npm publish --access public` can be added later for npm users.

## Use

After installation, either call the `self_verify` tool from the agent or run:

```text
/self-verify implement a safe change to the authentication boundary
```

With no argument, `/self-verify` uses the latest user task in the session.
The package also provides `/skill:self-verify` for agents that need the
workflow instructions explicitly.

Defaults are three candidates, two repeated evaluations per criterion, and one
pivot. Override them in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "verify": {
    "model": "deepseek-v4-flash",
    "evals": 2,
    "pivots": 1,
    "topLogprobs": 20
  }
}
```

Project settings override global settings. Tool arguments override environment
variables, which override the matching settings values:

| Variable | Purpose |
| --- | --- |
| `VERIFIER_PROVIDER` | `vertex` for Vertex Gemini; optionally `together`, `cerebras`, `fireworks`, `openrouter`, or `openai-compatible` |
| `VERIFIER_MODEL` | Verifier model id |
| `VERIFIER_API_KEY` | Explicit verifier API key |
| `VERIFIER_BASE_URL` | OpenAI-compatible `/v1` or `/chat/completions` base |
| `VERIFIER_AUTH_PROVIDER` | Explicit Pi `/login` provider id for stored API-key reuse with a custom HTTPS endpoint |
| `VERIFIER_TOP_LOGPROBS` | Alternatives per token, `1`–`20` (default `20`) |
| `VERIFIER_MAX_TOKENS` | Generic verifier output budget |
| `OPENAI_BASE_URL` | Fallback OpenAI-compatible base URL |
| `OPENAI_API_KEY` | Key for an OpenAI-compatible endpoint |
| `DEEPSEEK_API_KEY` | Hosted DeepSeek key |
| `VERIFIER_EVALS` | Repeated evaluations |
| `VERIFIER_PIVOTS` | Tournament pivots |
| `DEEPSEEK_EFFORT` | DeepSeek reasoning effort (`off`, `low`, `high`, `max`) |
| `DEEPSEEK_MAX_TOKENS` | DeepSeek output budget compatibility alias |
| `VERTEX_API_KEY` | Vertex API key |
| `VERTEX_ACCESS_TOKEN` | Vertex OAuth access token |
| `VERTEX_BASE_URL` | Full Vertex `:generateContent` URL (advanced) |
| `GOOGLE_CLOUD_PROJECT` | Vertex project id |
| `GOOGLE_CLOUD_LOCATION` | Vertex location, normally `global` |
| `VERTEX_THINKING_BUDGET` | Vertex thinking tokens, default `0` |

Without an explicit key, the extension reuses a stored API-key credential
configured with Pi's `/login deepseek` flow. It reads that credential through
Pi's auth API; it does not duplicate or print the auth file. OAuth credentials
such as `openai-codex` are valid for candidate generation, but are not
interchangeable with a DeepSeek/OpenAI-compatible logprob API key. Vertex uses
`VERTEX_API_KEY` or Application Default Credentials. OpenAI-compatible remote
endpoints must return `logprobs` and `top_logprobs`; a plain chat endpoint is
not enough for fine-grained scoring. HTTPS is required for remote endpoints;
HTTP is accepted only for localhost development. Redirects are rejected so
credentials cannot be forwarded to another host.

Candidate generation uses the current Pi model and only enables `read`,
`grep`, `find`, and `ls`. The verifier uses the configured endpoint directly.

## Verifier backends

The verifier accepts any OpenAI-compatible endpoint that returns
`choices[0].logprobs.content` and `top_logprobs`:

| Backend | Base URL | Example model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Together | `https://api.together.xyz/v1` | `Qwen/Qwen3.5-9B` |
| Cerebras | `https://api.cerebras.ai/v1` | `gpt-oss-120b` |
| OpenRouter | `https://openrouter.ai/api/v1` | provider/model with logprobs |
| Fireworks | `https://api.fireworks.ai/inference/v1` | deployment with logprobs |
| Local vLLM/SGLang | `http://localhost:8000/v1` | served open model |

The selected model must support logprobs; provider compatibility is not
model compatibility. Fireworks deployments commonly allow only five top
alternatives, so set `VERIFIER_TOP_LOGPROBS=5` there. OpenRouter must be
configured to route to a provider/model that accepts the parameter.

Vertex Gemini is also supported directly:

```bash
export VERIFIER_PROVIDER=vertex
export VERIFIER_MODEL=gemini-2.5-flash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_LOCATION=global
# Choose one:
export VERTEX_API_KEY=...
# or: gcloud auth application-default login
```

Vertex uses `responseLogprobs`/`logprobs` and requires a model/version that
still exposes them. For local or private use, vLLM/SGLang avoids sending
candidate text to a hosted verifier. A normal chat judge without token
logprobs is not equivalent to this fine-grained verifier.

## Migrating an existing local harness

If a project already has `.pi/skills/self-verify.md` and `.pi/verify/verify.py`,
install this package first, then remove those two local files to avoid loading
two workflows. For the existing Yifa checkout:

```bash
cd ~/Projects/your-financial-assistant
pi install /home/andrasat/Projects/pi-llm-self-verify -l
rm -f .pi/skills/self-verify.md .pi/verify/verify.py
```

Keep the existing `verify` settings and ignored artifact paths.

## Artifacts and privacy

Runs write the task, criteria, candidates, winner, and scores to:

```text
.pi/verify/candidates/<run-id>/
.pi/verify/trail.jsonl
```

The trail is intended as a local training/evaluation record and can contain
sensitive prompt or source text. Keep these paths ignored and review your
project's data policy before sharing them.

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript checking, the built-in test suite, and an npm
package dry run. Pi loads the TypeScript entry point directly; no build step or
runtime dependency is bundled.

## Agentic engineering contract

- Candidate generation is read-only and isolated from repository mutation.
- The selected answer remains subject to normal implementation, tests, and
  independent review.
- Small changes are preferred; prompts and scoring behavior have focused tests.
- CI runs the same `npm run check` gate as local development.

## License

MIT. See [LICENSE](LICENSE).
