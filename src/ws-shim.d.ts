declare module 'ws' {
	export class WebSocketServer {
		constructor(options: { port: number });
		on(event: 'connection', listener: (socket: WebSocketLike) => void): this;
		once(event: 'listening', listener: () => void): this;
		address(): { port: number } | string | null;
		close(callback?: () => void): void;
	}

	export interface WebSocketLike {
		on(event: 'message', listener: (raw: { toString(): string }) => void): this;
		send(message: string): void;
	}
}
