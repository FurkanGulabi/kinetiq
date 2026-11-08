# Kinetiq CNC backend (`src/server/cnc`)

This is the CNCjs GRBL server code, carried into Kinetiq so Kinetiq no longer depends on `../CNCJS-fork`.

- **Source:** `CNCJS-fork/src/server` at commit `a3922a1bf` (CNCjs 1.11.5). The CNCjs MIT licence is in [`LICENSE`](LICENSE).
- **Copied unchanged:** `controllers/Grbl/*`, `controllers/constants.js`, `controllers/utils/*`, `lib/*`, `services/{configstore,monitor,taskrunner}/*`, `store/`, `access-control.js`. The folder layout mirrors CNCjs so the relative imports are unchanged.
- **Changed:**
  - `services/cncengine/CNCEngine.js`: only the Grbl controller is registered. Marlin, Smoothie and TinyG/g2core imports and branches were removed.
  - `config/settings.js`: replaces `settings.{base,development,production}.js` with the fields the backend reads (`secret`, `rcfile`, `accessTokenLifetime`, `allowRemoteAccess`, `verbosity`, `winston.level`). It no longer imports `package.json`.
- **Not carried over:** the Express app, REST API, i18n, views, the Marlin/Smoothie/TinyG controllers and the CNCjs CLI.

The files stay JavaScript (`allowJs` in `tsconfig.server.json`) so the logic is line-for-line what ran under CNCjs. `src/server/backend.ts` is the typed entry point that loads the rc file and secret and constructs `CNCEngine`.

The browser talks to this backend with the CNCjs Socket.IO 2 protocol, documented in `docs/API_REFERENCE.md`.
