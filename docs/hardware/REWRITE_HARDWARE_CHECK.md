# Hardware check for the TypeScript backend (rewrite phase 6)

Branch `refactor/typescript-backend`. The fake-controller protocol diff showed identical serial traffic in all scenarios after every phase, but the fake is not a machine. This session confirms the rewritten backend on the real FluidNC board before the branch is merged to `main`.

The operator runs every step that moves the machine. Stop at the first surprise and note it here; `main` still has the proven JavaScript backend.

## Setup

```bash
git checkout refactor/typescript-backend
npm install
npm run dev
```

Open http://127.0.0.1:8000. Keep a hand on the e-stop.

## Steps

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Connect to the board | Banner in the console, state Idle (or Alarm), positions update about 4×/s | |
| 2 | Unlock / Home (if homing is configured) | `$X` / `$H` accepted, Idle afterwards | |
| 3 | Jog X, Y, Z with each step size | Moves the commanded distance and direction | |
| 4 | Long jog, then Stop jog (jog cancel, sent as `0xC2 0x85`, plan §3a bug 4) | Motion stops promptly | |
| 5 | Feed / spindle overrides +10, −10, +1, −1, reset during a job (`0xC2 0x9X`) | Values in the Job widget follow each step | |
| 6 | Run a short air job (Z above the stock) with an M0 or M6 | Pauses at M0/M6, Resume continues, job completes, toolpath greys out | |
| 7 | Pause / Resume mid-job | Feed hold then continue, no lost lines | |
| 8 | Stop mid-job | Hold, then soft reset; workflow returns to idle; position still correct | |
| 9 | Probe Z with the touch plate | Touch, retract, Z zero set as before | |
| 10 | Settings: read config, change one harmless value, save, restart | Saved and running config match after restart; revert the value afterwards | |
| 11 | Disconnect and reconnect | Reattaches; no leftover program loaded | |

## Afterwards

- All rows pass: merge `refactor/typescript-backend` into `main` (fast-forward is possible: the branch already contains `main`) and mark phase 6 done in `docs/BACKEND_REWRITE_PLAN.md`.
- If 4 or 5 misbehave, the cause is most likely the `0xC2` prefix on extended real-time bytes. It is the same in the JavaScript backend, so compare against `main` before changing it.
