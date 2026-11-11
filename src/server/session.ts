/// <reference path="../types/range_check.d.ts" />
/**
 * Session and access checks.
 *
 * GET /api/kinetiq/session → { token }
 *
 * Mints the JWT that the SocketEngine Socket.IO handshake requires (sent by the client as
 * `auth: { token }`, checked by authenticateSocketToken() below).
 * Same token format as CNCjs `api.users.signin` with no users configured: { id: '', name: '' }.
 * Served by the custom server itself because it must share the engine's `settings.secret`.
 *
 * Also holds the rest of the handshake checks, authorizeIPAddress() / validateUser() (was
 * src/server/cnc/access-control.js, CNCjs 1.11.5; ported unchanged in rewrite phase 5), which
 * engine/SocketEngine.ts runs after authenticateSocketToken() has verified the token.
 *
 * SERVER-ONLY. See docs/BACKEND_INTEGRATION.md §4.1.
 */
import type http from 'node:http';
import jwt from 'jsonwebtoken';
import _ from 'lodash';
import rangeCheck from 'range_check';
import settings from './config/settings';
import config from './config/ConfigStore';
import ensureArray from './util/ensureArray';
import type { CNCSettings } from './backend';

export const SESSION_PATH = '/api/kinetiq/session';

/**
 * Kinetiq: the only JWT algorithm the session token is signed and verified with. Pinned on both
 * sides so a token with another `alg` header (e.g. `none`) is never accepted.
 */
const SESSION_JWT_ALGORITHM = 'HS256' as const;

/** Verifies a session token against `secret`; returns its payload or throws jsonwebtoken's error. */
export function verifySessionToken(token: string, secret: string): string | jwt.JwtPayload {
  return jwt.verify(token, secret, { algorithms: [SESSION_JWT_ALGORITHM] });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Rejects requests whose Host header is not a loopback name (DNS-rebinding defence). */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
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
    algorithm: SESSION_JWT_ALGORITHM,
    expiresIn: settings.accessTokenLifetime as jwt.SignOptions['expiresIn'],
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ token }));
}

/** Loopback Host plus a valid session token (`Authorization: Bearer <token>`), for Kinetiq's HTTP APIs. */
export function isAuthorized(req: http.IncomingMessage, settings: CNCSettings): boolean {
  if (!isLoopbackHost(req.headers.host)) {
    return false;
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    verifySessionToken(token, settings.secret);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Socket handshake access control (was access-control.js, CNCjs)
// ---------------------------------------------------------------------------------------------

// Socket.IO handshakes are accepted from these ranges only, unless settings.allowRemoteAccess is
// set (it is false and nothing in Kinetiq sets it). The HTTP server listens on 127.0.0.1 by default.
const whitelist = [
  // IPv4 reserved space
  '127.0.0.0/8', // Used for loopback addresses to the local host
  '10.0.0.0/8', // Used for local communications within a private network
  '172.16.0.0/12', // Used for local communications within a private network
  '192.168.0.0/16', // Used for local communications within a private network
  '169.254.0.0/16', // Link-local address

  // IPv4 mapped IPv6 address
  '::ffff:10.0.0.0/8',
  '::ffff:127.0.0.0/8',
  '::ffff:172.16.0.0/12',
  '::ffff:192.168.0.0/16',

  // IPv6 reserved space
  '::1/128', // loopback address to the local host
  'fc00::/7', // Unique local address
  'fe80::/10' // Link-local address
];

/** The decoded session token (`socket.data.user`); `{}` when absent. Only id and name are read. */
export interface SessionUser {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/**
 * The `data` of the Error a token rejection carries to the client (`connect_error` → `err.data`).
 * Same `code`/`type` values socketio-jwt used, so the client can tell an auth failure apart from
 * the IP and user checks and refetch the token once.
 */
export interface SocketAuthErrorData {
  type: 'UnauthorizedError';
  code: 'credentials_required' | 'invalid_token';
}

/**
 * Kinetiq: the handshake's first step (replaces socketio-jwt, which does not support Socket.IO 4).
 * Verifies the session token from `socket.handshake.auth.token` against `settings.secret` and
 * returns its payload; throws an Error (with SocketAuthErrorData as `data`) for a missing, expired,
 * malformed or wrongly signed token.
 */
export function authenticateSocketToken(token: unknown): SessionUser {
  const reject = (code: SocketAuthErrorData['code'], message: string): never => {
    const err = new Error(message) as Error & { data: SocketAuthErrorData };
    err.data = { type: 'UnauthorizedError', code };
    throw err;
  };

  if (typeof token !== 'string' || !token) {
    return reject('credentials_required', 'No session token provided');
  }
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = verifySessionToken(token, settings.secret);
  } catch (err) {
    // jsonwebtoken's message, e.g. "jwt expired", "invalid signature", "jwt malformed".
    return reject('invalid_token', `Invalid session token: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Kinetiq only signs object payloads; a string payload carries no id/name.
  return typeof decoded === 'object' && decoded !== null ? (decoded as SessionUser) : {};
}

/** Resolves if the address is in `whitelist` (or remote access is allowed), else rejects. */
export const authorizeIPAddress = (ipaddr: string): Promise<void> => new Promise((resolve, reject) => {
  let pass = !!(settings.allowRemoteAccess);
  pass = pass || whitelist.some(test => rangeCheck.inRange(ipaddr, test));

  if (pass) {
    resolve();
  } else {
    reject(new Error(`Unauthorized IP address: ipaddr=${ipaddr}`));
  }
});

/**
 * Resolves if the rc file lists no enabled `users`, or one whose id AND name equal the token's
 * (lodash `_.find` matching; a token without id/name matches only a user with `id: null, name: null`).
 * Kinetiq's tokens are `{ id: '', name: '' }` and Kinetiq writes no `users`, so with an rc file that
 * has none (the default) this always passes.
 */
export const validateUser = (user: SessionUser | null | undefined): Promise<void> => new Promise((resolve, reject) => {
  const { id = null, name = null } = { ...user };

  const users = ensureArray(config.get<unknown>('users'))
    .filter((user): user is Record<string, unknown> => _.isPlainObject(user))
    .map(user => ({
      ...user,
      // Defaults to true if not explicitly initialized
      enabled: (user.enabled !== false)
    }));
  const enabledUsers = users.filter(user => user.enabled);

  if ((enabledUsers.length === 0) || _.find(enabledUsers, { id: id, name: name })) {
    resolve();
  } else {
    reject(new Error(`Unauthorized user: user.id=${id}, user.name=${name}`));
  }
});
