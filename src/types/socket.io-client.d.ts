// Minimal typings for socket.io-client@2 (the version that matches the CNCjs Socket.IO 2.2 server).
// Only the surface Kinetiq uses is declared.
declare module 'socket.io-client' {
  export interface ConnectOpts {
    query?: string | Record<string, string>;
    path?: string;
    transports?: string[];
    reconnection?: boolean;
    reconnectionDelay?: number;
    reconnectionDelayMax?: number;
    forceNew?: boolean;
  }

  export interface Socket {
    readonly id: string;
    readonly connected: boolean;
    io: { opts: ConnectOpts };
    on(event: string, listener: (...args: any[]) => void): Socket;
    off(event: string, listener?: (...args: any[]) => void): Socket;
    emit(event: string, ...args: any[]): Socket;
    connect(): Socket;
    disconnect(): Socket;
    close(): Socket;
  }

  function io(uri?: string, opts?: ConnectOpts): Socket;
  export default io;
}
