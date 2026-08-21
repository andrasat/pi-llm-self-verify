# Agent instructions

This repository is a small, dependency-free Pi package. Read `README.md`
before changing behavior.

## Shape

- `extensions/self-verify.ts` is the Pi entry point.
- `src/self-verify.ts` contains the testable workflow, prompt, tournament, and
  OpenAI-compatible/Vertex logprob clients.
- `skills/self-verify/SKILL.md` teaches the agent when to call the tool.
- Pi loads TypeScript directly; there is no build output to commit.

## Workflow

1. Keep candidate generation read-only: candidate subprocesses may inspect the
   project but must not write, execute shell commands, commit, or push.
2. Keep the verifier as a selection aid, never as a test, review, release, or
   issue-close gate.
3. Do not log API keys. Keep provider secrets in environment/Pi auth, not project settings. Run `npm run check` before handing off a change.
4. Keep the public package surface small and avoid new runtime dependencies.
5. Changes to prompts, scoring, or artifact paths need focused tests and a
   README update when user-visible behavior changes.

## Commands

```bash
npm install
npm run check
npm test
npm run typecheck
```

## Release check

`package.json` is the Pi package manifest. Test a local install with:

```bash
pi install /absolute/path/to/pi-llm-self-verify
```

For a published/tagged release, use:

```bash
pi install git:github.com/andrasat/pi-llm-self-verify@<tag>
```

Release only after `npm run check`, a clean package dry run, a pushed commit,
and a pushed `v0.1.0` tag. `npm publish --access public` is optional; Pi can
install the tagged Git package directly.
