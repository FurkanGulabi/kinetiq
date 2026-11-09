# Kinetiq CNC backend (`src/server/cnc`)

This is the CNCjs GRBL server code, carried into Kinetiq so Kinetiq no longer depends on `../CNCJS-fork`.

- **Source:** `CNCJS-fork/src/server` at commit `a3922a1bf` (CNCjs 1.11.5). The CNCjs MIT licence is in [`LICENSE`](LICENSE).
- **Copied, then changed only as listed below:** `controllers/Grbl/*`, `controllers/constants.js`, `controllers/utils/*`, `lib/*`, `services/{configstore,monitor,taskrunner}/*`, `store/`, `access-control.js`. The folder layout mirrors CNCjs so the relative imports are unchanged. Every Kinetiq change inside these files is marked with a `// Kinetiq:` or `// SECURITY (Kinetiq):` comment.
- **Changed:**
  - `services/cncengine/CNCEngine.js`: only the Grbl controller is registered. Marlin, Smoothie and TinyG/g2core imports and branches were removed. Added later (2026-11-09): if serial port detection fails, the `list` handler still answers with the ports from the rc file (`ports`) instead of an error, so the fake controller and manually listed ports stay selectable.
  - `config/settings.js`: replaces `settings.{base,development,production}.js` with the fields the backend reads (`secret`, `rcfile`, `accessTokenLifetime`, `allowRemoteAccess`, `verbosity`, `winston.level`). It no longer imports `package.json`.
- **Removed later (2026-11-08):** the `tool:change` routine with its `tool.*` config and `TOOL_CHANGE_POLICY_*` constants, and `lasertest:on`/`lasertest:off`. M6 is now always a manual tool-change pause: the M6 word is sent as a comment `(M6)` and the job pauses until Resume (CNCjs's default policy, no longer configurable). Touched files: `controllers/Grbl/GrblController.js`, `controllers/constants.js`.
- **Added later (2026-11-08):** `GrblController.setExclusive(on)` and the `exclusive` flag, used by the settings editor's XModem upload. While on, the query timer sends no `?`/`$G` and Feeder lines are dropped (the Feeder is reset); real-time bytes written through `write()` (Hold, Reset) still go out. Turning it off clears the query masks.
- **Comments only:** `lib/EventTrigger.js` and `services/taskrunner/index.js` carry the shell-command security notes (see below); their code is unchanged.
- **Not carried over:** the Express app, REST API, i18n, views, the Marlin/Smoothie/TinyG controllers and the CNCjs CLI.

## Security rule: shell commands

`services/taskrunner` runs shell commands. Today its only input is the `events` list in the rc file (`~/.kinetiqrc`), read by `lib/EventTrigger.js`. No socket or HTTP handler reaches it, and the only config value Kinetiq writes is `secret`.

Keep it that way:
- Never pass socket, HTTP or other frontend input to `taskRunner.run()`.
- Never add an API that writes `events`, or anything else that is later handed to `run()`, into the config.
- The planned Automation UI must offer a fixed allow-list of server-defined actions (for example "switch relay N on"), validated on the server, not free-form commands.

The files stay JavaScript (`allowJs` in `tsconfig.server.json`) so the logic is line-for-line what ran under CNCjs. `src/server/backend.ts` is the typed entry point that loads the rc file and secret and constructs `CNCEngine`.

The browser talks to this backend with the CNCjs Socket.IO 2 protocol, documented in `docs/API_REFERENCE.md`.
