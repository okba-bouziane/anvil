# Contributing to Anvil

Bug reports and pull requests are welcome.

## Set up

You need macOS, Node 20 or newer, and Git.

```bash
npm install
npm run dev
```

## Check your work

```bash
npm run typecheck
npm test
npm run e2e
```

`npm run e2e` opens the real app and drives it with a scripted stand-in for the model, so you don't need a model running. To test against a real model, start one and run:

```bash
REAL_MODEL=1 npx vitest run tests/real-model.test.ts
```

## Where things are

| Path | What it does |
|---|---|
| `src/main/agent.ts` | The loop that talks to the model and runs its tools |
| `src/main/protocol.ts` | Reads tool tags out of the model's streamed text |
| `src/main/changes.ts` | Review, keep, undo and step checkpoints |
| `src/main/tools.ts` | File tools, and the check that keeps them inside the project |
| `src/main/tscheck.ts` | TypeScript checks and automatic imports |
| `src/main/providers.ts`, `model.ts` | Anthropic, OpenAI-style servers and the local model server |
| `src/renderer/src` | The interface (React and Monaco) |

## Please keep these true

- The window never gets file system access or API keys. They stay in the main process.
- Tools the model calls can't leave the project folder.
- Commands the model wants to run ask first unless the user turned that off.
- A change that affects behavior comes with a test.
