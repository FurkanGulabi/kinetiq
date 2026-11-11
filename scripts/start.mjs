#!/usr/bin/env node
/**
 * `npm start`: the built server (dist/server.js, from `npm run build`) in production mode.
 * A Node launcher instead of `NODE_ENV=production node dist/server.js` so it also works in
 * Windows cmd/PowerShell. server.ts reads NODE_ENV when it is loaded, so it is set first.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../dist/server.js', import.meta.url));
if (!existsSync(server)) {
  console.error('[kinetiq] dist/server.js not found. Run `npm run build` first.');
  process.exit(1);
}

process.env.NODE_ENV = 'production';
await import(new URL('../dist/server.js', import.meta.url).href);
