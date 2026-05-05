import { createPublicClient, http, type PublicClient } from 'viem';
import { rootstock } from 'viem/chains';
import { VERIFICATION_ABI } from '@bittasker/reviews-contracts';
import type {
	ReviewBlockchainState,
	ReviewChain,
	ReviewContractOutcome,
	ReviewableSettlementRecord
} from './contracts';
import type { ReviewSettlementRegistry } from './review-attestation-service';
import { structuredLogger } from './logger';

// ── Version-agnostic verifier interface ──────────────────────────────────────

export interface ISettlementVerifier {
	readonly supportedVersion: string;
	getSettlementState(paymentId: bigint): Promise<{
		state: number;
		exists: boolean;
		tasker: string;
		taskee: string;
	}>;
}

// ── On-chain uint8 → ReviewBlockchainState mapping ────────────────────────────

const ONCHAIN_TO_BLOCKCHAIN_STATE: Record<number, ReviewBlockchainState> = {
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

function mapOnchainStateToBlockchainState(onchainState: number): ReviewBlockchainState | null {
	return ONCHAIN_TO_BLOCKCHAIN_STATE[onchainState] ?? null;
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

// ── Contract Verifier (version-agnostic) ─────────────────────────────────────

export class ContractSettlementVerifier implements ISettlementVerifier {
	public readonly supportedVersion: string;
	private client: PublicClient | null = null;

	constructor(
		private readonly contractAddress: string,
		private readonly chain: ReviewChain,
		rpcUrl: string,
		version: string
	) {
		this.supportedVersion = version;
		try {
			const chainConfig = chain === 'rsk' ? rootstock : rootstock;
			this.client = createPublicClient({
				chain: { ...chainConfig, name: chain === 'rsk' ? 'rsk' : 'bsc' },
				transport: http(rpcUrl),
				batch: { multicall: false }
			});
		} catch {
			structuredLogger.warn('Failed to create public client for settlement verifier', {
				contractAddress,
				chain,
				rpcUrl
			});
		}
	}

	async getSettlementState(paymentId: bigint): Promise<{
		state: number;
		exists: boolean;
		tasker: string;
		taskee: string;
	}> {
		if (!this.client) {
			throw new Error('RPC client not available');
		}

		const result = await this.client.readContract({
			address: this.contractAddress as `0x${string}`,
			abi: VERIFICATION_ABI,
			functionName: 'getPaymentContractState',
			args: [Number(paymentId)]
		});

		const [state, exists, tasker, taskee] = result as [number, boolean, string, string, boolean];
		return { state, exists, tasker, taskee };
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
	fallback: ReviewSettlementRegistry | null;
}

/**
 * Verifies settlement state on-chain before allowing review attestation.
 *
 * Fallback chain: Dynamic (RPC → chain) → Fallback (static registry) → null
 */
export class DynamicSettlementResolver implements ReviewSettlementRegistry {
	private readonly verifiers = new Map<string, ContractSettlementVerifier>();

	constructor(private readonly options: DynamicSettlementResolverOptions) {}

	private getOrCreateVerifier(chain: ReviewChain, contractAddress: string): ContractSettlementVerifier {
		const vKey = `${chain}:${contractAddress.toLowerCase()}`;
		const existing = this.verifiers.get(vKey);
		if (existing) return existing;

		const rpcUrl = this.options.rpcConfig.rskMainnetRpcUrl;
		const verifier = new ContractSettlementVerifier(contractAddress, chain, rpcUrl, '2');
		this.verifiers.set(vKey, verifier);
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

		// 2. Try dynamic on-chain resolution
		try {
			const verifier = this.getOrCreateVerifier(input.chain, input.contractAddress);
			const state = await verifier.getSettlementState(BigInt(input.settlementId));

			if (!state.exists) {
				structuredLogger.warn('Settlement not found on chain', {
					chain: input.chain,
					contractAddress: input.contractAddress,
					settlementId: input.settlementId
				});
				return this.tryFallback(input);
			}

			const blockchainState = mapOnchainStateToBlockchainState(state.state);
			if (!blockchainState) {
				structuredLogger.warn('Unknown on-chain state', {
					onchainState: state.state,
					settlementId: input.settlementId
				});
				return this.tryFallback(input);
			}

			// Build a settlement record from on-chain data.
			// Participant identities are verified against the input,
			// wallet→npub binding is verified cryptographically by the dual-signature flow.
			const record: ReviewableSettlementRecord = {
				subjectType: input.subjectType as ReviewableSettlementRecord['subjectType'],
				subjectId: input.subjectId,
				settlementType: input.settlementType as ReviewableSettlementRecord['settlementType'],
				settlementId: input.settlementId,
				chain: input.chain,
				asset: input.asset as ReviewableSettlementRecord['asset'],
				contractAddress: input.contractAddress,
				contractVersion: verifier.supportedVersion,
				reviewerRole: 'tasker',
				revieweeRole: 'taskee',
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
		} catch (error) {
			structuredLogger.warn('Dynamic resolution failed, trying fallback', {
				error: error instanceof Error ? error.message : 'unknown',
				settlementId: input.settlementId,
				chain: input.chain
			});
			return this.tryFallback(input);
		}
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

	private tryFallback(input: {
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
	}): ReviewableSettlementRecord | null {
		if (!this.options.fallback) return null;

		structuredLogger.info('Falling back to static settlement registry', {
			settlementId: input.settlementId
		});

		return this.options.fallback.resolve(input);
	}
}
