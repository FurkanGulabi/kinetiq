/**
 * GET /api/kinetiq/session → { token }
 *
 * Mints the JWT that CNCjs's Socket.IO handshake requires (socketio-jwt, handshake: true).
 * Same token format as CNCjs `api.users.signin` with no users configured: { id: '', name: '' }.
 * Served by the custom server itself because it must share the engine's `settings.secret`.
 *
 * SERVER-ONLY. See docs/BACKEND_INTEGRATION.md §4.1.
 */
import type http from 'node:http';
import jwt from 'jsonwebtoken';
import type { CNCSettings } from './cncjs';

export const SESSION_PATH = '/api/kinetiq/session';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Rejects requests whose Host header is not a loopback name (DNS-rebinding defence). */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function handleSession(req: http.IncomingMessage, res: http.ServerResponse, settings: CNCSettings): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  if (!isLoopbackHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'forbidden host' }));
    return;
  }

  const token = jwt.sign({ id: '', name: '' }, settings.secret, {
    expiresIn: settings.accessTokenLifetime as jwt.SignOptions['expiresIn'],
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ token }));
}
