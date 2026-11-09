// Minimal typings for spawn-default-shell@2 (CommonJS: `module.exports = { spawn }`).
// spawn() runs `command` through the user's default shell ($SHELL with `-l -c` on macOS/Linux).
declare module 'spawn-default-shell' {
  import type { ChildProcess, SpawnOptions } from 'child_process';

  const defaultShell: {
    spawn(command: string, spawnOpts?: SpawnOptions): ChildProcess;
  };

  export = defaultShell;
}
