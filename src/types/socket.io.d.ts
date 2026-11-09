// Minimal typings for the socket.io@2.2 SERVER (the package ships no types; @types/socket.io is not
// installed). Only the surface src/server/engine/SocketEngine.ts uses is declared.
//
// The `SocketIO` global namespace is the one socketio-jwt's bundled typings refer to
// (`/// <reference types="socket.io" />`, `SocketIO.Socket`), so declaring it here also gives
// `socketioJwt.authorize()` a real middleware type. Event names and payloads are typed by the
// engine against src/server/protocol.ts; here they are plain strings.
declare namespace SocketIO {
  interface Handshake {
    /** Remote address of the handshake request, e.g. '127.0.0.1' or '::ffff:192.168.1.5'. */
    address: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string>;
    time: string;
    issued: number;
    url: string;
    xdomain: boolean;
    secure: boolean;
  }

  interface Socket {
    readonly id: string;
    readonly handshake: Handshake;
    /**
     * The verified JWT payload, set by socketio-jwt (`decodedPropertyName`, default 'decoded_token').
     * Kinetiq only signs object payloads (src/server/session.ts), so it is an object of claims.
     */
    decoded_token?: { [claim: string]: unknown };
    // `never[]` so listeners with any parameter list are accepted; SocketEngine narrows them.
    on(event: string, listener: (...args: never[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    join(rooms: string | string[], fn?: (err?: unknown) => void): this;
    leave(room: string, fn?: (err?: unknown) => void): this;
  }

  interface Namespace {
    emit(event: string, ...args: unknown[]): this;
  }

  /** `next(err)` rejects the handshake: the client gets an 'error' packet (err.data, or err.message). */
  type Middleware = (socket: Socket, next: (err?: Error) => void) => void;

  interface Server {
    use(fn: Middleware): this;
    on(event: 'connection', listener: (socket: Socket) => void): Namespace;
    /** Emits to every connected socket of the default namespace. */
    emit(event: string, ...args: unknown[]): Namespace;
    close(fn?: () => void): void;
  }

  interface ServerOptions {
    /** Serve /socket.io/socket.io.js (default true). */
    serveClient?: boolean;
    /** Default '/socket.io'. */
    path?: string;
  }
}

declare module 'socket.io' {
  import type http from 'http';

  // `Server(srv, opts)` works with or without `new`; CNCjs called it as a function.
  function createServer(srv: http.Server, opts?: SocketIO.ServerOptions): SocketIO.Server;

  export = createServer;
}
