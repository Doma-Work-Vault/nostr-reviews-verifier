import { describe, it, expect, vi } from 'vitest';
import {
	DynamicSettlementResolver,
	InMemorySettlementCache,
	mapOnchainStateToBlockchainState,
	parseRpcConfigFromEnv
} from '../src/settlement-resolver';
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

// Mock verifier that returns controlled on-chain state
function createMockVerifier(options: {
	exists?: boolean;
	state?: number;
	taskerWallet?: string;
	taskeeWallet?: string;
	detectedMethod?: 'getPaymentContractState' | 'getEscrow';
}) {
	return {
		getSettlementState: vi.fn().mockResolvedValue({
			exists: options.exists ?? true,
			state: options.state ?? 7, // funds_released (payment contract)
			tasker: options.taskerWallet ?? '0xTASKER1111111111111111111111111111111111',
			taskee: options.taskeeWallet ?? '0xTASKEE2222222222222222222222222222222222',
			detectedMethod: options.detectedMethod ?? 'getPaymentContractState'
		})
	};
}

describe('mapOnchainStateToBlockchainState', () => {
	it('maps payment contract state 10 to work_in_progress', () => {
		expect(mapOnchainStateToBlockchainState(10, 'getPaymentContractState')).toBe('work_in_progress');
	});

	it('maps legacy getEscrow state 10 to funds_released (not work_in_progress)', () => {
		expect(mapOnchainStateToBlockchainState(10, 'getEscrow')).toBe('funds_released');
	});

	it('maps legacy getEscrow state 7 to work_in_progress', () => {
		expect(mapOnchainStateToBlockchainState(7, 'getEscrow')).toBe('work_in_progress');
	});

	it('maps legacy getEscrow states 12–16 to in_dispute', () => {
		for (const raw of [12, 13, 14, 15, 16]) {
			expect(mapOnchainStateToBlockchainState(raw, 'getEscrow')).toBe('in_dispute');
		}
	});
});

describe('DynamicSettlementResolver', () => {
	const TASKER_WALLET = '0xTASKER1111111111111111111111111111111111';
	const TASKEE_WALLET = '0xTASKEE2222222222222222222222222222222222';
	
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
		reviewerWallet: TASKER_WALLET,
		revieweeWallet: TASKEE_WALLET
	};

	it('returns null when no on-chain settlement found and no fallback', async () => {
		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({}),
			cache: new InMemorySettlementCache(),
			cacheTtlMs: 300_000,
			fallback: null
		});

		const result = await resolver.resolve(baseInput);
		expect(result).toBeNull();
	});

	describe('role determination based on reviewer wallet', () => {
		it('sets reviewerRole=tasker when reviewer wallet matches on-chain tasker', async () => {
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET,
				taskeeWallet: TASKEE_WALLET
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: null
			});

			// Inject mock verifier
			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			const result = await resolver.resolve({
				...baseInput,
				reviewerWallet: TASKER_WALLET, // Tasker is the reviewer
				revieweeWallet: TASKEE_WALLET
			});

			expect(result).not.toBeNull();
			expect(result!.reviewerRole).toBe('tasker');
			expect(result!.revieweeRole).toBe('taskee');
		});

		it('sets reviewerRole=taskee when reviewer wallet matches on-chain taskee', async () => {
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET,
				taskeeWallet: TASKEE_WALLET
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: null
			});

			// Inject mock verifier
			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			const result = await resolver.resolve({
				...baseInput,
				reviewerWallet: TASKEE_WALLET, // Taskee is the reviewer
				revieweeWallet: TASKER_WALLET
			});

			expect(result).not.toBeNull();
			expect(result!.reviewerRole).toBe('taskee');
			expect(result!.revieweeRole).toBe('tasker');
		});

		it('falls back when reviewer wallet does not match either party', async () => {
			const unknownWallet = '0xUNKNOWN0000000000000000000000000000000';
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET,
				taskeeWallet: TASKEE_WALLET
			});

			const fallbackRecord = makeSettlementRecord({
				reviewerRole: 'tasker',
				revieweeRole: 'taskee'
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: {
					resolve: vi.fn().mockResolvedValue(fallbackRecord)
				}
			});

			// Inject mock verifier
			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			const result = await resolver.resolve({
				...baseInput,
				reviewerWallet: unknownWallet,
				revieweeWallet: TASKEE_WALLET
			});

			// Should fall back because unknown wallet
			expect(result).toEqual(fallbackRecord);
		});

		it('handles case-insensitive wallet comparison', async () => {
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET.toLowerCase(),
				taskeeWallet: TASKEE_WALLET.toLowerCase()
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: null
			});

			// Inject mock verifier
			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			// Use uppercase reviewer wallet
			const result = await resolver.resolve({
				...baseInput,
				reviewerWallet: TASKER_WALLET.toUpperCase(),
				revieweeWallet: TASKEE_WALLET
			});

			expect(result).not.toBeNull();
			expect(result!.reviewerRole).toBe('tasker');
			expect(result!.revieweeRole).toBe('taskee');
		});
	});

	describe('settlement type handling', () => {
		it('maps legacy escrow terminal state 10 to funds_released on resolve', async () => {
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET,
				taskeeWallet: TASKEE_WALLET,
				state: 10,
				detectedMethod: 'getEscrow'
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: null
			});

			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			const result = await resolver.resolve({
				...baseInput,
				reviewerWallet: TASKER_WALLET
			});

			expect(result).not.toBeNull();
			expect(result!.blockchainState).toBe('funds_released');
			expect(result!.contractOutcome).toBe('completed');
			expect(result!.contractVersion).toBe('legacy_escrow');
		});

		it('preserves service_quote_contract settlement type', async () => {
			const mockVerifier = createMockVerifier({
				taskerWallet: TASKER_WALLET,
				taskeeWallet: TASKEE_WALLET
			});

			const resolver = new DynamicSettlementResolver({
				rpcConfig: parseRpcConfigFromEnv({}),
				cache: new InMemorySettlementCache(),
				cacheTtlMs: 300_000,
				fallback: null
			});

			// Inject mock verifier
			(resolver as any).verifiers.set(`rsk:${baseInput.contractAddress.toLowerCase()}`, mockVerifier);

			const result = await resolver.resolve({
				...baseInput,
				settlementType: 'service_quote_contract',
				reviewerWallet: TASKER_WALLET
			});

			expect(result).not.toBeNull();
			expect(result!.settlementType).toBe('service_quote_contract');
		});
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

