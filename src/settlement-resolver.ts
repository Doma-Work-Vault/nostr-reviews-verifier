import { createPublicClient, getAddress, http, type PublicClient } from 'viem';
import { rootstock } from 'viem/chains';
import { V2_PAYMENT_STATE_ABI, LEGACY_ESCROW_ABI } from '@bittasker/reviews-contracts';
import { fetchContractStatusEvents, type NostrQueryPool } from './nostr-status-query';
import {
	legacyEscrowHistoryHasFundsReleased,
	LEGACY_ONCHAIN_COMPLETED
} from './v1-legacy-nostr-status';
import type {
	ReviewBlockchainState,
	ReviewChain,
	ReviewContractOutcome,
	ReviewableSettlementRecord
} from './contracts';
import type { SettlementResolver } from './review-attestation-service';
import { structuredLogger } from './logger';

// ── Verifier interface ───────────────────────────────────────────────────────

export interface ISettlementVerifier {
	getSettlementState(settlementId: bigint): Promise<{
		state: number;
		exists: boolean;
		tasker: string;
		taskee: string;
		detectedMethod: 'getPaymentContractState' | 'getEscrow';
	}>;
}

// ── On-chain state mapping ───────────────────────────────────────────────────

/**
 * Payment / V2 contract: `getPaymentContractState` uint8 state values.
 * Must match the deployed payment contract enum (0–11).
 */
const PAYMENT_CONTRACT_ONCHAIN_STATE: Record<number, ReviewBlockchainState> = {
	0: 'funded',
	1: 'in_dispute',
	2: 'dispute_resolved',
	3: 'dispute_unresolved',
	4: 'completed',
	5: 'cancelled',
	6: 'refunded',
	7: 'funds_released',
	8: 'funds_claimed',
	9: 'no_show',
	10: 'work_in_progress',
	11: 'in_dispute_wip'
};

/**
 * Legacy `getEscrow` uint8 values use a **different** numbering than payment contracts.
 * For example, legacy **10** is a terminal “funds released” style state, while payment
 * contracts use **10** for `work_in_progress`. Never use PAYMENT_CONTRACT_ONCHAIN_STATE
 * for `getEscrow` results.
 *
 * States **12–16** are legacy dispute variants, all mapped to `in_dispute` (see
 * `LEGACY_ESCROW_DISPUTE_STATE_*` in `mapOnchainStateToBlockchainState`).
 */
const LEGACY_ESCROW_DISPUTE_STATE_MIN = 12;
const LEGACY_ESCROW_DISPUTE_STATE_MAX = 16;

const LEGACY_GET_ESCROW_ONCHAIN_STATE: Partial<Record<number, ReviewBlockchainState>> = {
	0: 'funded',
	1: 'in_dispute',
	2: 'dispute_resolved',
	3: 'dispute_unresolved',
	4: 'completed',
	5: 'cancelled',
	6: 'funded',
	7: 'work_in_progress',
	8: 'completed',
	9: 'funded',
	10: 'funds_released',
	11: 'completed'
};

export function mapOnchainStateToBlockchainState(
	rawState: number,
	detectedMethod: 'getPaymentContractState' | 'getEscrow'
): ReviewBlockchainState | null {
	if (detectedMethod === 'getEscrow') {
		if (
			rawState >= LEGACY_ESCROW_DISPUTE_STATE_MIN &&
			rawState <= LEGACY_ESCROW_DISPUTE_STATE_MAX
		) {
			return 'in_dispute';
		}
		return LEGACY_GET_ESCROW_ONCHAIN_STATE[rawState] ?? null;
	}
	return PAYMENT_CONTRACT_ONCHAIN_STATE[rawState] ?? null;
}

// ── RPC Configuration ────────────────────────────────────────────────────────

export interface SettlementRpcConfig {
	rskMainnetRpcUrl: string;
	rskTestnetRpcUrl: string;
	bscMainnetRpcUrl: string;
	bscTestnetRpcUrl: string;
}

export function parseRpcConfigFromEnv(env: Record<string, string | undefined>): SettlementRpcConfig {
	return {
		rskMainnetRpcUrl: env.RSK_MAINNET_RPC_URL || env.RSK_RPC_URL || 'https://public-node.rsk.co',
		rskTestnetRpcUrl: env.RSK_TESTNET_RPC_URL || 'https://public-node.testnet.rsk.co',
		bscMainnetRpcUrl: env.BSC_MAINNET_RPC_URL || env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
		bscTestnetRpcUrl: env.BSC_TESTNET_RPC_URL || 'https://data-seed.bsc.testnet.noditon.io'
	};
}

// ── Version-Agnostic Contract Verifier ───────────────────────────────────────

/**
 * Version-agnostic settlement verifier.
 * 
 * Automatically detects which function the contract supports:
 *   1. First tries getPaymentContractState (newer contracts)
 *   2. If that fails/reverts, tries getEscrow (legacy contracts)
 * 
 * Results are returned in a unified format regardless of which method succeeded.
 */
export class ContractSettlementVerifier implements ISettlementVerifier {
	private client: PublicClient | null = null;
	private readonly contractAddress: string;

	constructor(
		contractAddress: string,
		private readonly chain: ReviewChain,
		rpcUrl: string
	) {
		try {
			this.contractAddress = getAddress(contractAddress.trim().toLowerCase() as `0x${string}`);
			const chainConfig = chain === 'rsk' ? rootstock : rootstock;
			this.client = createPublicClient({
				chain: { ...chainConfig, name: chain === 'rsk' ? 'rsk' : 'bsc' },
				transport: http(rpcUrl),
				batch: { multicall: false }
			});
		} catch (error) {
			this.contractAddress = contractAddress.trim().toLowerCase();
			structuredLogger.warn('Failed to create public client for settlement verifier', {
				contractAddress,
				chain,
				rpcUrl,
				error: error instanceof Error ? error.message : 'unknown'
			});
		}
	}

	async getSettlementState(settlementId: bigint): Promise<{
		state: number;
		exists: boolean;
		tasker: string;
		taskee: string;
		detectedMethod: 'getPaymentContractState' | 'getEscrow';
	}> {
		if (!this.client) {
			throw new Error('RPC client not available');
		}

		// Try getPaymentContractState first (newer contracts)
		try {
			const result = await this.client.readContract({
				address: this.contractAddress as `0x${string}`,
				abi: V2_PAYMENT_STATE_ABI,
				functionName: 'getPaymentContractState',
				args: [Number(settlementId)]
			});

			const [state, exists, tasker, taskee] = result;
			return { 
				state, 
				exists, 
				tasker, 
				taskee, 
				detectedMethod: 'getPaymentContractState' as const
			};
		} catch (error) {
			structuredLogger.info('getPaymentContractState failed, trying getEscrow', {
				settlementId: settlementId.toString(),
				error: error instanceof Error ? error.message : 'unknown'
			});
		}

		// Legacy contracts: getEscrow(uint256)
		try {
			const escrow = await this.client.readContract({
				address: this.contractAddress as `0x${string}`,
				abi: LEGACY_ESCROW_ABI,
				functionName: 'getEscrow',
				args: [settlementId]
			});

			// Check if escrow exists (zero address client means not found)
			const zeroAddress = '0x0000000000000000000000000000000000000000';
			const exists = escrow.client !== zeroAddress && escrow.client !== '0x';

			return {
				state: escrow.state,
				exists,
				tasker: escrow.client,
				taskee: escrow.freelancer,
				detectedMethod: 'getEscrow' as const
			};
		} catch (error) {
			structuredLogger.warn('Both getPaymentContractState and getEscrow failed', {
				settlementId: settlementId.toString(),
				contractAddress: this.contractAddress,
				error: error instanceof Error ? error.message : 'unknown'
			});
			throw error;
		}
	}
}

// ── Settlement Cache ─────────────────────────────────────────────────────────

interface CachedSettlementEntry {
	data: ReviewableSettlementRecord;
	fetchedAt: number;
	expiresAt: number;
}

export interface SettlementCache {
	get(key: string): Promise<CachedSettlementEntry | null>;
	set(key: string, data: ReviewableSettlementRecord, ttlMs: number): Promise<void>;
	invalidate(key: string): Promise<void>;
}

export class InMemorySettlementCache implements SettlementCache {
	private readonly store = new Map<string, CachedSettlementEntry>();

	async get(key: string): Promise<CachedSettlementEntry | null> {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return null;
		}
		return entry;
	}

	async set(key: string, data: ReviewableSettlementRecord, ttlMs: number): Promise<void> {
		const now = Date.now();
		this.store.set(key, {
			data,
			fetchedAt: now,
			expiresAt: now + ttlMs
		});
	}

	async invalidate(key: string): Promise<void> {
		this.store.delete(key);
	}
}

function buildCacheKey(chain: string, contractAddress: string, settlementId: string): string {
	return `settlement:${chain}:${contractAddress.toLowerCase()}:${settlementId}`;
}

// ── Dynamic Settlement Resolver ──────────────────────────────────────────────

export interface DynamicSettlementResolverOptions {
	rpcConfig: SettlementRpcConfig;
	cache: SettlementCache;
	cacheTtlMs: number;
	/** When set, legacy v1 escrows in on-chain Completed use Kind 31006 to detect FundsReleased. */
	nostrQuery?: {
		pool: NostrQueryPool;
		relays: string[];
	};
}

/**
 * Verifies settlement state on-chain before allowing review attestation.
 *
 * Resolution: in-memory cache (TTL) → on-chain RPC (`getPaymentContractState`, then `getEscrow`).
 * Legacy v1: when getEscrow is Completed (4), optionally fuse Kind 31006 FundsReleased (same as BitTasker UI).
 * If the chain cannot resolve the settlement, returns null (no static or off-chain fallback).
 */
export class DynamicSettlementResolver implements SettlementResolver {
	private readonly verifiers = new Map<string, ContractSettlementVerifier>();

	constructor(private readonly options: DynamicSettlementResolverOptions) {}

	private getOrCreateVerifier(chain: ReviewChain, contractAddress: string): ContractSettlementVerifier {
		const key = `${chain}:${contractAddress.toLowerCase()}`;
		const existing = this.verifiers.get(key);
		if (existing) return existing;

		const rpcUrl = this.options.rpcConfig.rskMainnetRpcUrl;
		const verifier = new ContractSettlementVerifier(contractAddress, chain, rpcUrl);
		this.verifiers.set(key, verifier);
		return verifier;
	}

	async resolve(input: {
		subjectType: string;
		subjectId: string;
		settlementType: string;
		settlementId: string;
		chain: ReviewChain;
		asset: string;
		contractAddress: string;
		reviewerNpub: string;
		revieweeNpub: string;
		reviewerWallet: string;
		revieweeWallet: string;
	}): Promise<ReviewableSettlementRecord | null> {
		const cacheKey = buildCacheKey(input.chain, input.contractAddress, input.settlementId);

		// 1. Check cache first
		const cached = await this.options.cache.get(cacheKey);
		if (cached) {
			return cached.data;
		}

		// 2. On-chain resolution (auto-detects contract method); failures → null
		try {
			const result = await this.tryOnchainResolution(input, cacheKey);
			if (result) return result;
		} catch (error) {
			structuredLogger.warn('On-chain resolution failed', {
				error: error instanceof Error ? error.message : 'unknown',
				settlementId: input.settlementId
			});
		}

		return null;
	}

	private async tryOnchainResolution(
		input: Parameters<typeof this.resolve>[0],
		cacheKey: string
	): Promise<ReviewableSettlementRecord | null> {
		const verifier = this.getOrCreateVerifier(input.chain, input.contractAddress);
		const state = await verifier.getSettlementState(BigInt(input.settlementId));

		if (!state.exists) {
			structuredLogger.info('Settlement not found on chain', {
				chain: input.chain,
				contractAddress: input.contractAddress,
				settlementId: input.settlementId,
				detectedMethod: state.detectedMethod
			});
			return null;
		}

		let blockchainState = mapOnchainStateToBlockchainState(state.state, state.detectedMethod);
		if (!blockchainState) {
			structuredLogger.warn('Unknown on-chain state', {
				onchainState: state.state,
				settlementId: input.settlementId,
				detectedMethod: state.detectedMethod
			});
			return null;
		}

		blockchainState = await this.applyV1NostrFundsReleasedFusion(
			input,
			state,
			blockchainState
		);

		// Hint for observability only — settlement uses detectedMethod + mapping, not this string
		const contractVersion = state.detectedMethod === 'getPaymentContractState' ? 'payment' : 'legacy_escrow';

		return this.buildSettlementRecord(input, state, blockchainState, contractVersion, cacheKey);
	}

	/**
	 * v1 escrow keeps state Completed on-chain after payout; BitTasker UI uses Kind 31006 FundsReleased.
	 */
	private async applyV1NostrFundsReleasedFusion(
		input: Parameters<typeof this.resolve>[0],
		state: { state: number; detectedMethod: 'getPaymentContractState' | 'getEscrow' },
		blockchainState: ReviewBlockchainState
	): Promise<ReviewBlockchainState> {
		if (state.detectedMethod !== 'getEscrow') {
			return blockchainState;
		}
		if (state.state !== LEGACY_ONCHAIN_COMPLETED || blockchainState !== 'completed') {
			return blockchainState;
		}

		const nostr = this.options.nostrQuery;
		if (!nostr?.pool || nostr.relays.length === 0) {
			structuredLogger.info('Skipping v1 Nostr fusion (no relay pool configured)', {
				subjectId: input.subjectId,
				settlementId: input.settlementId
			});
			return blockchainState;
		}

		const subjectId = input.subjectId?.trim();
		if (!subjectId) {
			return blockchainState;
		}

		const statusEvents = await fetchContractStatusEvents(nostr.pool, nostr.relays, subjectId);
		if (!legacyEscrowHistoryHasFundsReleased(statusEvents, state.state)) {
			return blockchainState;
		}

		structuredLogger.info('v1 legacy escrow: Nostr FundsReleased fused over on-chain Completed', {
			subjectId,
			settlementId: input.settlementId,
			statusEventCount: statusEvents.length
		});
		return 'funds_released';
	}

	private async buildSettlementRecord(
		input: Parameters<typeof this.resolve>[0],
		state: { state: number; exists: boolean; tasker: string; taskee: string },
		blockchainState: ReviewBlockchainState,
		contractVersion: string,
		cacheKey: string
	): Promise<ReviewableSettlementRecord | null> {
		// Determine reviewer/reviewee roles based on which party is submitting the review
		const normalizedReviewerWallet = input.reviewerWallet.toLowerCase();
		const normalizedTaskerWallet = state.tasker.toLowerCase();
		const normalizedTaskeeWallet = state.taskee.toLowerCase();

		let reviewerRole: 'tasker' | 'taskee';
		let revieweeRole: 'tasker' | 'taskee';

		if (normalizedReviewerWallet === normalizedTaskerWallet) {
			reviewerRole = 'tasker';
			revieweeRole = 'taskee';
		} else if (normalizedReviewerWallet === normalizedTaskeeWallet) {
			reviewerRole = 'taskee';
			revieweeRole = 'tasker';
		} else {
			structuredLogger.warn('Reviewer wallet does not match on-chain participants', {
				reviewerWallet: normalizedReviewerWallet,
				taskerWallet: normalizedTaskerWallet,
				taskeeWallet: normalizedTaskeeWallet,
				settlementId: input.settlementId,
				contractVersion
			});
			return null;
		}

		const record: ReviewableSettlementRecord = {
			subjectType: input.subjectType as ReviewableSettlementRecord['subjectType'],
			subjectId: input.subjectId,
			settlementType: input.settlementType as ReviewableSettlementRecord['settlementType'],
			settlementId: input.settlementId,
			chain: input.chain,
			asset: input.asset as ReviewableSettlementRecord['asset'],
			contractAddress: input.contractAddress,
			contractVersion,
			reviewerRole,
			revieweeRole,
			reviewerNpub: input.reviewerNpub,
			revieweeNpub: input.revieweeNpub,
			reviewerWallet: input.reviewerWallet,
			revieweeWallet: input.revieweeWallet,
			blockchainState,
			completedAt: 0,
			reviewableAt: 0,
			contractOutcome: this.deriveContractOutcome(blockchainState),
			status: 'reviewable',
			sourceVisibility: 'public_present',
			sourcePresentation: {},
			sourceRefs: {}
		};

		await this.options.cache.set(cacheKey, record, this.options.cacheTtlMs);
		return record;
	}

	private deriveContractOutcome(state: ReviewBlockchainState): ReviewContractOutcome {
		switch (state) {
			case 'funds_released':
			case 'funds_claimed':
			case 'completed':
				return 'completed';
			case 'dispute_resolved':
				return 'disputed_resolved_payout';
			case 'dispute_unresolved':
			case 'refunded':
				return 'refunded';
			default:
				return 'completed';
		}
	}
}
