# Contributing to Kinetiq

Thanks for helping. Kinetiq drives real machines, so some rules here are stricter than in an ordinary web project. Please read them before you open a pull request.

## Setup

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` serves the UI and the backend on <http://127.0.0.1:8000>. Without a machine, use the fake controller ([docs/FAKE_CONTROLLER.md](docs/FAKE_CONTROLLER.md)); it needs macOS, Linux or WSL.

## Checks

There is no test suite and no linter, and pull requests should not add them. The checks are:

1. **`npm run typecheck`** must pass. It covers the app and the server.
2. **Protocol scenarios**, for any change under `src/server/` or in the UI sequencing code (`client.ts`, `lineSequence.ts`, `probe.ts`, `leveling/run.ts`). They record exactly what the backend writes to the serial port and compare it with the committed baseline:

   ```bash
   npm run protocol:record -- --out /tmp/proto-new
   ```

   ```bash
   npm run protocol:compare -- scripts/protocol-scenarios/baseline /tmp/proto-new
   ```

   The recorder drives the fake controller, so it needs macOS, Linux or WSL. If a difference is intended, re-record into `scripts/protocol-scenarios/baseline` and commit it with the change. Explain the difference in the pull request. [scripts/protocol-scenarios/README.md](scripts/protocol-scenarios/README.md) has the details.
3. **Try it.** Say in the pull request what you ran it against: the fake controller, or a real machine with its firmware and version.

## Safety rules

Treat every change that affects what reaches the serial port as safety-relevant.

- **Nothing in `src/app`, `src/components` or `src/lib` may import `src/server/**`.** This keeps the serial port and the engine out of the Next.js bundles, so there can never be two handles on the port. Code both sides need goes in a dependency-free module under `src/lib`.
- **No optimistic machine state.** The UI renders only what the backend broadcasts. A jog changes nothing locally.
- **Gating lives in `src/lib/cnc/derive.ts`** as pure view functions. A disabled control must state its reason.
- **Never pass socket, HTTP or other frontend input to the shell runner** (`src/server/events/TaskRunner.ts`). See [docs/BACKEND_INTEGRATION.md](docs/BACKEND_INTEGRATION.md) §7.2.
- **Software controls are never called an emergency stop**, in the UI or in the docs.
- `src/server/protocol.ts` and `src/lib/cnc/protocol.ts` describe the same socket events and must stay in sync. `socket.io` and `socket.io-client` are upgraded together.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the structure and the UI rules (§9): one accent colour, every status pairs an icon with a label, axes are identified by letters, and nothing animates on high-frequency actions. UI text is English.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope, and say why in the body: `feat(jog): …`, `fix(limits): …`, `docs(readme): …`.
- Keep a pull request to one topic.
- Update the matching document in `docs/` when behaviour changes.
- Code added on top of the CNCjs port is marked with a `// Kinetiq:` comment.

## Reporting bugs

Use the bug report template. The firmware and version, the operating system and the terminal log around the problem make most reports solvable. For anything that could let someone else move a machine or run code, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Hardware results

Reports from other machines are valuable, including "it works". If you ran Kinetiq on a controller or firmware that is not listed in the README, open an issue with the firmware, the board and what you tried.
