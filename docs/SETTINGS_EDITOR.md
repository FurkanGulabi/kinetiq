# Machine Settings Editor (FluidNC config) — Design

**Status:** approved 2026-11-08 with the recommended options in §8. **S1 (read), S2 (edit) and S3 (save) built** 2026-11-08/09. S3's restart has not been run on the machine yet. S4 (live tuning) not started.
**Based on:** the hardware capture in `hardware/2026-11-08-fluidnc-config-read.md` and the FluidNC docs (commands and settings, config overview, XModem).
**Target:** FluidNC v4.0.1 over USB serial (the connection Kinetiq already holds). Wi-Fi/HTTP upload is not used.

---

## 1. Goals and non-goals

**Goals**
1. Show the machine's config as **saved** on the controller (`config.yaml`) and as **running** in memory, and point out where they differ.
2. Edit it safely: a form for common fields, a raw YAML view for everything, validation before anything is written.
3. Save it back **exactly as edited**, comments and layout kept, with a backup taken first.
4. Restart FluidNC and show the boot log, so config errors and warnings (like today's X homing warning) are visible right away.
5. Later: live tuning (`$/path=value`) for motion values, without restarting.

**Non-goals (v1)**
- Wi-Fi, Telnet and other `$S` settings stored outside `config.yaml`. They're a separate list with secrets (`$Sta/Password`), and deserve their own screen.
- Multiple config files and switching `$Config/Filename`. Kinetiq reads it and uses whatever file is active.
- Firmware updates.

---

## 2. How each operation maps to FluidNC

| Operation | FluidNC command | Verified on v4.0.1 |
|---|---|---|
| Active file name | `$Config/Filename` → `$Config/Filename=config.yaml` | Yes |
| Free space | `$LocalFS/List` → `[/littlefs/ Free:… Used:… Total:…]` | Yes |
| Saved file | `$LocalFS/Show=<file>` → one line per YAML line, then `ok` | Yes (86 lines, 0.2 s) |
| Running config | `$CD` → 187 lines, then `ok` | Yes (0.4 s) |
| One running value | `$/axes/x/steps_per_mm` → `$/axes/x/steps_per_mm=400.000` | Yes |
| Boot log / warnings | `$SS` → `[MSG:INFO|WARN|ERR: …]` | Yes |
| Write file | `$Xmodem/Receive=<file>` (`$XR`), then an XModem-1K CRC16 transfer | Yes (1,946-byte file, byte-identical read-back) |
| Rename / delete | `$LocalFS/Rename=<old>><new>`, `$LocalFS/Delete=<file>` | Yes (used by every save) |
| Restart | `$Bye` | **Not yet** |
| Live change | `$/axes/x/acceleration_mm_per_sec2=200` (memory only) | **Not yet** |

**Why not `$CD=config.yaml` to save:** the dump isn't the file. It upper-cases axis keys, writes `NO PIN` instead of `NO_PIN`, quotes pins, adds about 100 default lines and drops comments. FluidNC's own docs advise against it. Kinetiq only ever writes the file text the user edited.

All of these are only allowed when the machine is **Idle or Alarm** and no job is running (§6).

---

## 3. Architecture

```
Browser                                   Kinetiq server                         FluidNC
SettingsEditor ──HTTP──▶ /api/kinetiq/machine-config/* ──▶ exchange.ts ──serial──▶ $ commands
   (form + YAML)   (src/server/fluidnc/machineConfig.ts)   (+ xmodem.ts)      ◀── lines … ok
                                   │
                                   └── ~/.kinetiq/config-backups/   (copy taken before every write; KINETIQ_CONFIG_BACKUP_DIR)
```

### 3.1 Why HTTP and not new socket events
These are request/response operations that take 0.2–10 s and return one result: "here is the file", "saved and verified". That maps directly onto HTTP, and Kinetiq already has the pattern (`jobs.ts`: loopback host check plus the session token). The socket protocol and the copied CNCjs engine stay untouched.

### 3.2 Server: `src/server/fluidnc/`
| File | Responsibility |
|---|---|
| `exchange.ts` | **One exchange at a time.** Takes the open controller from the backend store and sends one command with `controller.writeln()`. It collects reply lines from `controller.connection`'s `data` event until `ok`/`error:N`, with a timeout. A lock rejects a second request with 409 "busy". |
| `xmodem.ts` | XModem-1K sender with CRC16, written from FluidNC's reference TypeScript implementation (`breiler/fluid-installer`, `src/utils/xmodem/xmodem.ts`). |
| `machineConfig.ts` | The HTTP endpoints (§3.4), backups, read-back verification. |

**Collecting replies safely.** The backend keeps polling while we talk to FluidNC:
- `?` gets back `<…>` status lines, so lines starting with `<` are skipped.
- `$G` (only when idle) gets back `[GC:…]` plus its own `ok`. If a `[GC:` line arrives before our output, the next `ok` belongs to it and is skipped.

GRBL replies strictly in order, so this is enough for read commands. The capture showed no mixing, but the server shouldn't rely on that.

**Exclusive mode for XModem (the only change to the CNCjs backend code for this feature).** A binary transfer must not get a `?` byte from the status poll in the middle of it. Two small, documented hooks in `GrblController`:
- `controller.setExclusive(true|false)`: while it's on, the query timer skips `?`/`$G`, and Feeder lines are dropped (the Feeder is reset, logged). Turning it off clears the query masks so polling resumes.
- The transfer itself reads raw bytes from `controller.connection.port` alongside the line parser, and writes raw bytes to it directly.

FluidNC's `[MSG:INFO: Received N bytes]` after the transfer is read as a normal line again. This change is listed with the other Kinetiq changes in `BACKEND_INTEGRATION.md` §7.1 (code: `src/server/controller/GrblController.ts`, `StatusPoller.ts`).

**Settings-parser cleanup (done in S1).** CNCjs's settings parser matches any `$…=…` line. So replies like `$Config/Filename=config.yaml` and `$/axes/x/steps_per_mm=400.000` would end up as fake entries in `controller:settings`. After an exchange, `exchange.ts` keeps only numeric GRBL settings (`$0`…`$255`) in `runner.settings`, and the controller broadcasts the cleaned object on its next tick.

### 3.3 Backups
- Before every write, the current saved file (read with `$LocalFS/Show`, not from the browser) is saved to `~/.kinetiq/config-backups/<ISO-time>-<file>` (directory override: `KINETIQ_CONFIG_BACKUP_DIR`), mode 0600. The newest 20 are kept.
- "Restore backup" is just a write of that text, with the same checks.

### 3.4 Endpoints (all: loopback Host, Bearer session token, `Cache-Control: no-store`)
| Method & path | Does | Returns |
|---|---|---|
| `GET /api/kinetiq/machine-config` | `$Config/Filename`, `$LocalFS/Show`, `$CD`, `$SS`, `$LocalFS/List` | `{ filename, saved, savedSha256, running, bootLog: [{level, text}], fs: {files, free, used, total}, differences: [{path, saved, running}], defaultsCount, readAt }` |
| `PUT /api/kinetiq/machine-config` body `{ text, baseSha256 }` | Re-reads the file. If its hash ≠ `baseSha256` → 409 (it changed underneath you). Checks free space, writes the backup, uploads to `kinetiq-new.yaml` with XModem, reads it back, then swaps it in: rename the active file to `kinetiq-prev.yaml`, rename the new one to the active name (undoing the first rename if the second fails), read back again, delete the previous file. FluidNC's receiver writes straight into the target file, so uploading to the active name directly could leave it truncated after a failed transfer. | `{ filename, savedSha256, bytes, backup, restartRequired: true }` |
| `POST /api/kinetiq/machine-config/restart` | `$Bye`, then collects boot messages until the FluidNC banner plus a 1.5 s tail, or 25 s | `{ bootLog, banner }` |
| `POST /api/kinetiq/machine-config/live` body `{ path, value }` (stage S4, not built) | `$<path>=<value>`, then reads the value back | `{ path, value }` |
| `GET /api/kinetiq/machine-config/backups` | List | `[{ id, filename, size, savedAt }]` |
| `GET /api/kinetiq/machine-config/backups/<id>` | Backup text | text/plain |
| `POST /api/kinetiq/machine-config/backups/<id>/restore` | Saves a backup with the same steps as `PUT` (the UI instead loads a backup into the editor, so it goes through review) | as `PUT` |

Errors: `409 busy` (another exchange running), `409 not-idle` (machine/job state), `409 changed` (hash mismatch), `412 not-connected`, `504 timeout`, `507 no-space`, `502 upload-failed`, `502 verify-failed` (read-back mismatch), `400`/`413 invalid`, `404 not-found`, `403` (auth). The body is `{ error, code }`, with a human-readable `error`.

---

## 4. Frontend

### 4.1 Where it lives
A **Settings** button (gear icon) in the top bar, between Leveling and Reset layout, left of the machine controls. It opens a large glass sheet built on a non-modal Radix Dialog, full height below the top bar and up to 1280 px wide (`SettingsPanel.tsx` → `SettingsEditor.tsx`). Kinetiq stays one page, with no navigation.

A normal modal dialog would block the top bar, including Hold and Reset. So this panel sits **below the 48 px top bar** and covers only the workspace. The top bar stays clickable the whole time, so Hold/Reset are always reachable (Principle 5).

### 4.2 Layout
```
┌ MACHINE SETTINGS · config.yaml · FluidNC v4.0.1 ─────────────── Form | YAML ──── [Reload] [×] ┐
│ ▲ 1 boot warning: X — Motor0 switches do not support positive homing dir   [Show boot log]   │
├──────────────┬────────────────────────────────────────────────────────────────────────────────┤
│ General      │ AXIS X                                                                         │
│ Axes         │  Steps per mm          [ 400      ]  steps/mm                                  │
│   X  ▲       │  Max rate              [ 1000     ]  mm/min                                    │
│   Y          │  Acceleration          [ 25       ]  mm/s²                                     │
│   Z          │  Max travel            [ 1000     ]  mm                                        │
│ Spindle      │  Soft limits           [ off ]                                                 │
│ Probe        │  HOMING                                                                        │
│ Stepping     │  Cycle                 [ 1 ]      Positive direction [ on ] ▲ conflicts with   │
│ Advanced     │                                                         neg-only limit switch │
│              │  Seek / Feed           [ 500 ] [ 100 ] mm/min                                  │
│              │  ▸ Motor 0 (pins)  — Advanced: wrong pins can drive outputs unexpectedly       │
├──────────────┴────────────────────────────────────────────────────────────────────────────────┤
│ 2 changes · requires restart            [Discard]                 [Review & save…]            │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Form view:** sections taken from the file's own top-level keys. Known fields get typed inputs with units, ranges and help text (§4.3). Unknown keys still show as plain text inputs, so nothing in the file is hidden or lost.
- **YAML view:** the full saved text in a code editor (plain `<textarea>` with a monospace font and line numbers in v1, no new editor dependency). Form and YAML edit the same document.
- **Running view:** the `$CD` dump (read-only), next to the saved-vs-running differences.
- **"Running" hint:** when the `$CD` value differs from the file (for example a field left out of the file that falls back to a default), it shows under the input: "running: 500 (default)".
- **Pins** (`*_pin`) go under a collapsed "Advanced" group per motor/section, with a warning. They're editable, but never the first thing you see.

### 4.3 Document model and validation
- **As built (S2):** the text is the single source of truth (`src/lib/fluidnc/configText.ts`). A form edit replaces only the value on one line (or inserts one line), so **comments, order and formatting are kept** and the diff shows only real changes. The new dependency **`yaml`** (eemeli/yaml) is used for syntax checking and for the saved-vs-running comparison on the server, not for writing. It is the only new dependency.
- **Field schema:** `src/lib/fluidnc/schema.json`, generated from FluidNC's `docs/config_items.yaml` by `scripts/build-fluidnc-schema.mjs`. It provides type, range, enum values, default and description for every config field (about 490, pinned to FluidNC commit `e928c5e1db`); units come from `configText.unitFor()`. That file comes from FluidNC `main` (newer than v4.0.1), so a few fields may not exist on the machine's firmware; none are added automatically.
- **Checks before "Review & save" is enabled:**
  1. The YAML parses, with no tabs and consistent indentation (FluidNC requires spaces).
  2. Types and ranges match the schema.
  3. Cross-field rules seen in practice: homing `positive_direction` vs which limit pin exists (today's warning), `cycle` numbers, no pin used twice.
  4. Size: the new file fits in LocalFS free space plus the old file's size.
- Warnings don't block saving. Errors do.

### 4.4 Save flow
1. **Review dialog**: a line diff of the old and new file, which changes need a restart (all file changes do), and the backup file name.
2. **Save**: the progress shows each step: backup ✓ → upload ✓ → verify ✓.
3. **"Restart FluidNC now?"**, explaining that the machine comes back in **Alarm** and needs Home or Unlock, and that the position will be lost.
4. **After the restart**: the new boot log, with warnings/errors highlighted, then a fresh read. If FluidNC reports config errors, show "Restore previous config" (the backup from step 2) right there.

### 4.5 When the editor is unavailable
The Settings button stays visible. The dialog opens, but read/save are **disabled with a stated reason**, following the existing `disabledReason` pattern:
- "Connect to the controller first"
- "Not available while a job is running or paused"
- "Machine is Jog: wait until it is Idle" (any state other than Idle or Alarm)
- "Waiting for the previous command to be accepted"
- "Settings operation in progress" / "Probing in progress" / "Height-map probing in progress" (`derive.busyReason`); the server answers a second concurrent request with 409 "Another settings operation is in progress"

While the dialog has an operation running, jog and job Start are disabled with "Settings operation in progress".

---

## 5. Live tuning (stage S4)
For numeric motion fields only (steps/mm, max rate, acceleration, homing feed/seek): an "Apply live" action sends `$/path=value` and reads it back. The field then shows "**live, not saved**" until it's saved to the file. Restarting without saving discards live values, and the dialog says so. Pins and structural keys are never applied live (FluidNC needs a restart for them anyway).

---

## 6. Safety rules
1. **Gate every operation** on: connected, workflow `idle`, machine `Idle` or `Alarm`. The server checks this, not just the UI.
2. **One operation at a time** (server lock). Reads and writes never overlap with each other or with jogs (the UI disables jog meanwhile).
3. **Never write anything the user didn't review.** A diff is always shown before a write, and a backup is always taken first.
4. **Verify every write** by reading the file back and comparing bytes. A mismatch is reported as a failure, with the backup offered.
5. **Restart is explicit**, never automatic, and the Alarm/lost-position consequence is stated.
6. **Hold/Reset stay reachable**: the dialog never covers the top bar.
7. No shell, no task runner, no `$S` secrets involved.

---

## 7. Stages
Each stage can be used on its own and is checked on the machine. Nothing in S1–S3 moves the machine. The first restart in S3 is done with you watching.

| Stage | Delivers | Machine check |
|---|---|---|
| **S1 Read** ✓ | `fluidnc/exchange.ts`, `GET` endpoint (`fluidnc/machineConfig.ts`), panel with saved/running YAML views (read-only), boot warnings, running-vs-saved differences, the settings-parser cleanup | Done 2026-11-08: read through the UI, busy gating and settings cleanup checked on the machine |
| **S2 Edit** ✓ | Text model (`lib/fluidnc/configText.ts`: edits change one line, comments kept), field reference with descriptions (`schema.json`, generated by `scripts/build-fluidnc-schema.mjs`), form/YAML views, validation, diff | Done 2026-11-09 in the browser |
| **S3 Save** ✓ (restart not yet run) | Backups, exclusive mode, XModem upload, read-back, rename swap, restart + boot log, backups loaded into the editor | Done 2026-11-09: unchanged file saved through the full path (byte-identical, temp files removed), refusals checked, polling resumes. **Still to do with you present:** a real edit plus a restart |
| **S4 Live tuning** | `$/path=value` apply and read-back, "live, not saved" state | Change acceleration live, read back, discard by restart |

---

## 8. Decisions for you
1. **Placement:** the Settings dialog below the top bar (recommended), or a separate `/settings` page?
2. **Editing scope:** form plus raw YAML with pins under "Advanced" (recommended), or the form only, with no pins editable in Kinetiq?
3. **Live tuning:** include it as S4 (recommended), or leave it out?
4. **Fix the X homing warning** using the editor once S3 lands, or sooner by hand?
