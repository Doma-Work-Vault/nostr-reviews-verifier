import { describe, it, expect } from 'vitest';
import { SimplePool } from 'nostr-tools';
import {
	DynamicSettlementResolver,
	InMemorySettlementCache,
	parseRpcConfigFromEnv
} from '../src/settlement-resolver';

const RUN_LIVE = process.env.V1_FUSION_INTEGRATION === '1';

describe.skipIf(!RUN_LIVE)('v1 Nostr fusion integration (set V1_FUSION_INTEGRATION=1)', () => {
	it('resolves escrow 96 as funds_released when Nostr history has legacy s=10', async () => {
		const pool = new SimplePool({ enableReconnect: false, enablePing: false });
		const relays = ['wss://relay1.bittasker.com'];

		const resolver = new DynamicSettlementResolver({
			rpcConfig: parseRpcConfigFromEnv({
				RSK_MAINNET_RPC_URL: 'https://mainnet.sovryn.app/rpc'
			}),
			cache: new InMemorySettlementCache(),
			cacheTtlMs: 0,
			nostrQuery: { pool, relays }
		});

		const result = await resolver.resolve({
			subjectType: 'task',
			subjectId: 'bcd21fd6e468d3a297615edcce9bd1abe1d7dacc6b31f8aed95e7481b46dbb0f',
			settlementType: 'escrow',
			settlementId: '96',
			chain: 'rsk',
			asset: 'rbtc',
			contractAddress: '0x674A253Efe9B740193b34e69694B67971E4335bf',
			reviewerNpub: '881a94948d101bd69a15713787f588866f5ec9f25a0f76f7d52d9c06d7c625e8',
			revieweeNpub: 'ceda26d39d2e9aeee53c2a475b6b056145213ec6ac6acdb183357f66f8de76b2',
			reviewerWallet: '0xbce4Ad0450a99722198BAa4E7D13F16829Cd8FD5',
			revieweeWallet: '0xbfDAAC189F6ebF4FEb611A20a44f4933696C4bff'
		});

		pool.close(relays);

		expect(result).not.toBeNull();
		expect(result!.blockchainState).toBe('funds_released');
		expect(result!.contractOutcome).toBe('completed');
	}, 30_000);
});
