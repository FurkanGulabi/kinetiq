#!/usr/bin/env node
/**
 * `npm run dev:fake`: `npm run dev` with KINETIQ_RC pointing at the rc file the fake controller
 * writes (scripts/fake-controller.py --rc, default <tmpdir>/kinetiq-fake.rc). A Node launcher
 * instead of `KINETIQ_RC=... npm run dev` so it also works in Windows cmd/PowerShell.
 * os.tmpdir() resolves to the same directory as Python's tempfile.gettempdir().
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const rc = process.env.KINETIQ_RC || path.join(os.tmpdir(), 'kinetiq-fake.rc');
console.log(`[dev:fake] KINETIQ_RC=${rc}`);

const child = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32', // npm is npm.cmd on Windows
  env: { ...process.env, KINETIQ_RC: rc },
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
