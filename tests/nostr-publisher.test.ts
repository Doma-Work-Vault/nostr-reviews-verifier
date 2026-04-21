import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { RelayReviewNostrPublisher } from '../src/nostr-publisher';

describe('RelayReviewNostrPublisher', () => {
	let server: WebSocketServer | null = null;

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			if (!server) {
				resolve();
				return;
			}

			server.close(() => resolve());
			server = null;
		});
	});

	it('publishes an attestation event to a real relay socket', async () => {
		const receivedEvents: Array<{ id: string; kind: number }> = [];

		server = new WebSocketServer({ port: 0 });
		server.on('connection', (socket) => {
			socket.on('message', (raw) => {
				const message = JSON.parse(raw.toString()) as [string, ...unknown[]];
				if (message[0] !== 'EVENT') {
					return;
				}

				const event = message[1] as { id: string; kind: number };
				receivedEvents.push({ id: event.id, kind: event.kind });
				socket.send(JSON.stringify(['OK', event.id, true, 'accepted']));
			});
		});

		await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
		const address = server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Expected an ephemeral TCP port for relay smoke test');
		}

		const publisher = new RelayReviewNostrPublisher([`ws://127.0.0.1:${address.port}`], 2_000);
		const event = finalizeEvent(
			{
				kind: 6431,
				created_at: Math.floor(Date.now() / 1000),
				tags: [['e', 'a'.repeat(64)]],
				content: JSON.stringify({ ok: true })
			},
			generateSecretKey()
		);

		try {
			await publisher.publish(event);
		} finally {
			publisher.destroy();
		}

		expect(receivedEvents).toEqual([{ id: event.id, kind: event.kind }]);
	});
});
