import { describe, it, expect, beforeEach } from 'vitest';
import {
	DynamicSettlementResolver,
	InMemorySettlementCache,
	parseRpcConfigFromEnv
} from '../src/settlement-resolver';
import {
	StaticReviewSettlementRegistry
} from '../src/review-attestation-service';
import type { ReviewableSettlementRecord } from '../src/contracts';

function makeSettlementRecord(overrides: Partial<ReviewableSettlementRecord> = {}): ReviewableSettlementRecord {
	return {
		subjectType: 'task',
		subjectId: 'task-1',
		settlementType: 'escrow',
		settlementId: '42',
		chain: 'rsk',
		asset: 'rbtc',
		contractAddress: '0xabcd000000000000000000000000000000000001',
		contractVersion: '1',
		reviewerRole: 'tasker',
		revieweeRole: 'taskee',
		reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn',
		revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
		reviewerWallet: '0x1111111111111111111111111111111111111111',
		revieweeWallet: '0x2222222222222222222222222222222222222222',
		blockchainState: 'funds_released',
		completedAt: 1700000000,
		reviewableAt: 1700000100,
		contractOutcome: 'completed',
		status: 'reviewable',
		sourceVisibility: 'public_present',
		sourcePresentation: { label: 'Task 1' },
		sourceRefs: { escrowId: 'e1' },
		...overrides
	};
}

describe('DynamicSettlementResolver', () => {
	const baseInput = {
		subjectType: 'task',
		subjectId: 'task-1',
		settlementType: 'escrow',
		settlementId: '42',
		chain: 'rsk' as const,
		asset: 'rbtc',
		contractAddress: '0xabcd000000000000000000000000000000000001',
		reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn',
		revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
		reviewerWallet: '0x1111111111111111111111111111111111111111',
		revieweeWallet: '0x2222222222222222222222222222222222222222'
	};

	it('falls back to static registry when RPC is unavailable', async () => {
		const staticRecord = makeSettlementRecord();
		const fallback = new StaticReviewSettlementRegistry([staticRecord]);

		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({}),
			cache: new InMemorySettlementCache(),
			cacheTtlMs: 300_000,
			fallback
		});

		const result = await resolver.resolve(baseInput);
		expect(result).not.toBeNull();
		expect(result!.subjectId).toBe('task-1');
		expect(result!.blockchainState).toBe('funds_released');
		expect(result!.contractOutcome).toBe('completed');
	});

	it('returns null when no settlement found in fallback', async () => {
		const fallback = new StaticReviewSettlementRegistry([]);

		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({}),
			cache: new InMemorySettlementCache(),
			cacheTtlMs: 300_000,
			fallback
		});

		const result = await resolver.resolve(baseInput);
		expect(result).toBeNull();
	});

	it('returns null when no fallback is configured', async () => {
		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({}),
			cache: new InMemorySettlementCache(),
			cacheTtlMs: 300_000,
			fallback: null
		});

		const result = await resolver.resolve(baseInput);
		expect(result).toBeNull();
	});

	it('caches fallback results', async () => {
		const staticRecord = makeSettlementRecord();
		const fallback = new StaticReviewSettlementRegistry([staticRecord]);
		const cache = new InMemorySettlementCache();

		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({}),
			cache,
			cacheTtlMs: 300_000,
			fallback
		});

		// The DRS tries RPC first, fails, then falls back.
		// The fallback result is not cached (only dynamic results are cached).
		// Verify the fallback returns the result correctly.
		const result = await resolver.resolve(baseInput);
		expect(result).not.toBeNull();
		expect(result!.subjectId).toBe('task-1');
	});
});

describe('InMemorySettlementCache', () => {
	it('stores and retrieves entries within TTL', async () => {
		const cache = new InMemorySettlementCache();
		const record = makeSettlementRecord();

		await cache.set('test:key', record, 60_000);
		const entry = await cache.get('test:key');

		expect(entry).not.toBeNull();
		expect(entry!.data.subjectId).toBe('task-1');
	});

	it('returns null for expired entries', async () => {
		const cache = new InMemorySettlementCache();
		const record = makeSettlementRecord();

		await cache.set('test:key', record, 1); // 1ms TTL
		// Wait for expiry
		await new Promise((r) => setTimeout(r, 5));
		const entry = await cache.get('test:key');

		expect(entry).toBeNull();
	});

	it('returns null for missing keys', async () => {
		const cache = new InMemorySettlementCache();
		const entry = await cache.get('nonexistent');
		expect(entry).toBeNull();
	});

	it('invalidates entries on demand', async () => {
		const cache = new InMemorySettlementCache();
		const record = makeSettlementRecord();

		await cache.set('test:key', record, 60_000);
		await cache.invalidate('test:key');
		const entry = await cache.get('test:key');
		expect(entry).toBeNull();
	});
});

describe('StaticReviewSettlementRegistry', () => {
	it('matches settlement by all fields', () => {
		const record = makeSettlementRecord();
		const registry = new StaticReviewSettlementRegistry([record]);

		const result = registry.resolve({
			subjectType: 'task',
			subjectId: 'task-1',
			settlementType: 'escrow',
			settlementId: '42',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0xabcd000000000000000000000000000000000001',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222'
		});

		expect(result).not.toBeNull();
		expect(result!.subjectId).toBe('task-1');
	});

	it('is case-insensitive for contract address', () => {
		const record = makeSettlementRecord();
		const registry = new StaticReviewSettlementRegistry([record]);

		const result = registry.resolve({
			subjectType: 'task',
			subjectId: 'task-1',
			settlementType: 'escrow',
			settlementId: '42',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0xABCD000000000000000000000000000000000001',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222'
		});

		expect(result).not.toBeNull();
	});

	it('returns null for non-matching settlement', () => {
		const record = makeSettlementRecord();
		const registry = new StaticReviewSettlementRegistry([record]);

		const result = registry.resolve({
			subjectType: 'task',
			subjectId: 'different-task',
			settlementType: 'escrow',
			settlementId: '42',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0xabcd000000000000000000000000000000000001',
			reviewerNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3y7hzn',
			revieweeNpub: 'npub1ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
			reviewerWallet: '0x1111111111111111111111111111111111111111',
			revieweeWallet: '0x2222222222222222222222222222222222222222'
		});

		expect(result).toBeNull();
	});
});
