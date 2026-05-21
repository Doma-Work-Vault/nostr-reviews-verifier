import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import {
	challengeRoute,
	attestationRoute,
	challengeRequestSchema,
	attestationRequestSchema,
	issuerRegistryOpenApiSchema,
	reviewErrorResponseSchema
} from './contracts';
import {
	ReviewApiError,
	ReviewAttestationService,
	parseRuntimeConfigFromEnv,
	parseSlotHmacSecretFromEnv
} from './review-attestation-service';
import { CloudflareReviewStateClient, type ReviewStateNamespace } from './state';
import { getIssuerRegistry } from './issuer-registry';
import { z } from 'zod';
import { RelayReviewNostrPublisher, type ReviewNostrPublisher } from './nostr-publisher';
import { corsMiddleware } from './middleware/cors';
import { structuredLogger } from './logger';
import {
	DynamicSettlementResolver,
	InMemorySettlementCache,
	parseRpcConfigFromEnv
} from './settlement-resolver';
import {
	ReplyAttestationService,
	replyChallengeRequestSchema,
	replyAttestationRequestSchema
} from './reply-attestation-service';
import { SimplePool } from 'nostr-tools';

export interface ReviewsAttestationEnv {
	REVIEW_STATE: ReviewStateNamespace;
	REVIEW_ATTESTATION_ISSUER_KEY_ID?: string;
	REVIEW_ATTESTATION_ISSUER_NPUB?: string;
	REVIEW_ATTESTATION_ISSUER_NSEC?: string;
	REVIEW_ATTESTATION_ISSUER_REGISTRY_JSON?: string;
	/** TOML `string[]` in `wrangler.toml` — omit from `.dev.vars` (string override breaks the binding). */
	REVIEW_ATTESTATION_NOSTR_RELAYS?: string[];
	REVIEW_CHALLENGE_TTL_SECONDS?: string;
	REVIEW_ATTESTATION_TTL_SECONDS?: string;
	REVIEW_RATE_LIMIT_WINDOW_SECONDS?: string;
	REVIEW_SLOT_HMAC_SECRET?: string;
	ALLOWED_ORIGINS?: string;
	RSK_RPC_URL?: string;
	RSK_MAINNET_RPC_URL?: string;
	RSK_TESTNET_RPC_URL?: string;
	BSC_RPC_URL?: string;
	BSC_MAINNET_RPC_URL?: string;
	BSC_TESTNET_RPC_URL?: string;
	SETTLEMENT_CACHE_TTL_SECONDS?: string;
}

export interface ReviewsAttestationAppOptions {
	publisher?: ReviewNostrPublisher;
	nonce?: () => string;
}

export interface ReviewsAttestationVars {
	clientIp: string;
}

function isZodLikeError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: unknown }).name === 'ZodError' &&
		'issues' in error &&
		Array.isArray((error as { issues?: unknown }).issues)
	);
}

const issuerRegistryRoute = createRoute({
	method: 'get',
	path: '/review-attestation-issuers',
	responses: {
		200: {
			description: 'Issuer registry',
			content: {
				'application/json': {
					schema: issuerRegistryOpenApiSchema
				}
			}
		}
	}
});

const healthRoute = createRoute({
	method: 'get',
	path: '/health',
	responses: {
		200: {
			description: 'Health check',
			content: {
				'application/json': {
					schema: z.object({ ok: z.literal(true) })
				}
			}
		}
	}
});

export function createReviewsAttestationApp(
	env?: ReviewsAttestationEnv,
	options: ReviewsAttestationAppOptions = {}
) {
	const app = new OpenAPIHono<{ Bindings: ReviewsAttestationEnv; Variables: ReviewsAttestationVars }>();

	app.doc('/openapi.json', {
		openapi: '3.0.0',
		info: {
			title: 'reviews-attestation-backend',
			version: '0.0.0'
		}
	});

	app.use('*', async (c, next) => {
		const forwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
		c.set('clientIp', c.req.header('cf-connecting-ip') ?? forwardedFor ?? '127.0.0.1');
		await next();
	});

	app.use(
		'*',
		bodyLimit({
			maxSize: 1024 * 1024, // 1MB
			onError: (c) => {
				return c.json(
					{
						schemaVersion: 1,
						status: 'error',
						code: 'request_invalid',
						message: 'Payload too large'
					},
					413
				);
			}
		})
	);

	app.use('*', corsMiddleware);

	app.onError((error, c) => {
		if (error instanceof HTTPException && error.status === 400) {
			return c.json(
				reviewErrorResponseSchema.parse({
					schemaVersion: 1,
					status: 'error',
					code: 'request_invalid',
					message: 'Invalid request payload'
				}),
				400
			);
		}

		return respondWithServiceError(c, error);
	});

	app.openapi(healthRoute, (c) => c.json({ ok: true }));

	app.openapi(issuerRegistryRoute, (c) => {
		try {
			const registry = getIssuerRegistry({
				...c.env,
				clock: () => Date.now()
			});
			return c.json(registry);
		} catch (error) {
			return respondWithServiceError(c, new ReviewApiError(
				'issuer_unavailable',
				503,
				error instanceof Error ? error.message : 'Issuer registry unavailable'
			))
		}
	});

	app.openAPIRegistry.registerPath(challengeRoute);
	app.post(challengeRoute.path, async (c) => {
		try {
			const body = challengeRequestSchema.parse(await c.req.json());
			const service = createService(c.env, options);
			const result = await service.createChallenge(body, {
				clientIp: c.get('clientIp'),
				now: Date.now()
			});
			return c.json(result);
		} catch (error) {
			return respondWithServiceError(c, error)
		}
	});

	app.openAPIRegistry.registerPath(attestationRoute);
	app.post(attestationRoute.path, async (c) => {
		try {
			const body = attestationRequestSchema.parse(await c.req.json());
			const service = createService(c.env, options);
			const result = await service.issueAttestation(body, {
				clientIp: c.get('clientIp'),
				now: Date.now()
			});
			return c.json(result);
		} catch (error) {
			return respondWithServiceError(c, error)
		}
	});

	// ── Reply attestation routes ──────────────────────────────────────

	app.post('/review-reply-attestations/challenge', async (c) => {
		try {
			const body = replyChallengeRequestSchema.parse(await c.req.json());
			const replyService = createReplyService(c.env, options);
			const result = await replyService.createChallenge(body, {
				clientIp: c.get('clientIp'),
				now: Date.now()
			});
			return c.json(result);
		} catch (error) {
			return respondWithServiceError(c, error)
		}
	});

	app.post('/review-reply-attestations', async (c) => {
		try {
			const body = replyAttestationRequestSchema.parse(await c.req.json());
			const replyService = createReplyService(c.env, options);
			const result = await replyService.issueAttestation(body, {
				clientIp: c.get('clientIp'),
				now: Date.now()
			});
			return c.json(result);
		} catch (error) {
			return respondWithServiceError(c, error)
		}
	});

	return app;
}

function respondWithServiceError(
	c: {
		json: (body: unknown, status?: number) => Response;
		header: (name: string, value: string) => void;
	},
	error: unknown
): Response {
	if (error instanceof z.ZodError || error instanceof SyntaxError) {
		return c.json(
			reviewErrorResponseSchema.parse({
				schemaVersion: 1,
				status: 'error',
				code: 'request_invalid',
				message: 'Invalid request payload'
			}),
			400
		);
	}

	if (isZodLikeError(error)) {
		return c.json(
			reviewErrorResponseSchema.parse({
				schemaVersion: 1,
				status: 'error',
				code: 'request_invalid',
				message: 'Invalid request payload'
			}),
			400
		);
	}

	if (error instanceof Error && error.name === 'BodyLimitError') {
		return c.json(
			reviewErrorResponseSchema.parse({
				schemaVersion: 1,
				status: 'error',
				code: 'request_invalid',
				message: 'Payload too large'
			}),
			413
		);
	}

	if (error instanceof ReviewApiError) {
		structuredLogger.error(`ReviewApiError: ${error.code}`, error, {
			code: error.code,
			status: error.status,
			message: error.message,
			retryAfterSeconds: error.retryAfterSeconds
		});

		if (error.retryAfterSeconds) {
			c.header('retry-after', String(error.retryAfterSeconds));
		}

		return c.json(
			reviewErrorResponseSchema.parse({
				schemaVersion: 1,
				status: 'error',
				code: error.code,
				message: error.message,
				...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
			}),
			error.status
		);
	}

	structuredLogger.error('Unexpected backend error', error instanceof Error ? error : undefined, {
		code: 'internal_error',
		status: 500
	});

	return c.json(
		reviewErrorResponseSchema.parse({
			schemaVersion: 1,
			status: 'error',
			code: 'internal_error',
			message: 'Unexpected backend error'
		}),
		500
	);
}

function trimRelayUrls(relays: string[] | undefined): string[] {
	if (relays === undefined) {
		return [];
	}
	if (!Array.isArray(relays)) {
		throw new Error(
			'REVIEW_ATTESTATION_NOSTR_RELAYS must be string[] from wrangler.toml [vars]. If you set it in .dev.vars, remove that line — string values override the array binding and break this worker.'
		);
	}
	if (relays.length === 0) {
		return [];
	}
	return relays.map((r) => r.trim()).filter((r) => r.length > 0);
}

function createService(env: ReviewsAttestationEnv, options: ReviewsAttestationAppOptions = {}) {
	const parsedCacheTtl = env.SETTLEMENT_CACHE_TTL_SECONDS
		? parseInt(env.SETTLEMENT_CACHE_TTL_SECONDS, 10)
		: 300;
	const cacheTtlSeconds =
		Number.isFinite(parsedCacheTtl) && parsedCacheTtl > 0 ? parsedCacheTtl : 300;

	const rpcConfigEnv: Record<string, string | undefined> = {
		RSK_RPC_URL: env.RSK_RPC_URL,
		RSK_MAINNET_RPC_URL: env.RSK_MAINNET_RPC_URL,
		RSK_TESTNET_RPC_URL: env.RSK_TESTNET_RPC_URL,
		BSC_RPC_URL: env.BSC_RPC_URL,
		BSC_MAINNET_RPC_URL: env.BSC_MAINNET_RPC_URL,
		BSC_TESTNET_RPC_URL: env.BSC_TESTNET_RPC_URL
	};

	const relays = trimRelayUrls(env.REVIEW_ATTESTATION_NOSTR_RELAYS);
	const nostrQueryPool = new SimplePool({ enableReconnect: false, enablePing: false });

	const settlementResolver = new DynamicSettlementResolver({
		rpcConfig: parseRpcConfigFromEnv(rpcConfigEnv),
		cache: new InMemorySettlementCache(),
		cacheTtlMs: cacheTtlSeconds * 1000,
		nostrQuery: relays.length > 0 ? { pool: nostrQueryPool, relays } : undefined
	});

	const publisher =
		options.publisher ?? new RelayReviewNostrPublisher(relays, 10_000);
	return new ReviewAttestationService({
		state: new CloudflareReviewStateClient(env.REVIEW_STATE),
		settlementResolver,
		publisher,
		issuerRegistryEnv: env,
		config: parseRuntimeConfigFromEnv(env),
		slotHmacSecret: parseSlotHmacSecretFromEnv(env),
		clock: () => Date.now(),
		nonce: options.nonce
	});
}

function createReplyService(env: ReviewsAttestationEnv, options: ReviewsAttestationAppOptions = {}) {
	const relays = trimRelayUrls(env.REVIEW_ATTESTATION_NOSTR_RELAYS);
	const pool = new SimplePool({ enableReconnect: false, enablePing: false });

	const publisher =
		options.publisher ??
		new RelayReviewNostrPublisher(relays, 10_000);

	return new ReplyAttestationService({
		state: new CloudflareReviewStateClient(env.REVIEW_STATE),
		publisher,
		queryPool: pool,
		relays,
		issuerRegistryEnv: env,
		config: parseRuntimeConfigFromEnv(env),
		clock: () => Date.now(),
		nonce: options.nonce
	});
}
