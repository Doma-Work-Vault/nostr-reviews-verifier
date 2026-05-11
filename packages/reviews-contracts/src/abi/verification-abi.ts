/**
 * V2 contract ABI fragment for getPaymentContractState.
 * Used by newer contracts that support this function signature.
 */
export const V2_PAYMENT_STATE_ABI = [
	{
		inputs: [{ internalType: 'uint32', name: 'paymentId', type: 'uint32' }],
		name: 'getPaymentContractState',
		outputs: [
			{ internalType: 'uint8', name: 'state', type: 'uint8' },
			{ internalType: 'bool', name: 'exists', type: 'bool' },
			{ internalType: 'address', name: 'tasker', type: 'address' },
			{ internalType: 'address', name: 'taskee', type: 'address' },
			{ internalType: 'bool', name: 'noShowMarked', type: 'bool' }
		],
		stateMutability: 'view',
		type: 'function'
	}
] as const;

/**
 * Legacy contract ABI fragment for getEscrow.
 * Used by older contracts (V1) that use the escrow struct pattern.
 */
export const LEGACY_ESCROW_ABI = [
	{
		inputs: [{ internalType: 'uint256', name: 'escrowId', type: 'uint256' }],
		name: 'getEscrow',
		outputs: [
			{
				components: [
					{ internalType: 'address', name: 'client', type: 'address' },
					{ internalType: 'address', name: 'freelancer', type: 'address' },
					{ internalType: 'uint256', name: 'amount', type: 'uint256' },
					{ internalType: 'uint32', name: 'estimatedStartTime', type: 'uint32' },
					{ internalType: 'uint32', name: 'estimatedCompletionTime', type: 'uint32' },
					{ internalType: 'uint32', name: 'timelockEnd', type: 'uint32' },
					{ internalType: 'uint32', name: 'createdAt', type: 'uint32' },
					{ internalType: 'uint8', name: 'clientFeeTier', type: 'uint8' },
					{ internalType: 'uint8', name: 'freelancerFeeTier', type: 'uint8' },
					{ internalType: 'uint8', name: 'state', type: 'uint8' },
					{ internalType: 'uint8', name: 'reserved', type: 'uint8' }
				],
				internalType: 'struct EscrowContract.Escrow',
				name: '',
				type: 'tuple'
			}
		],
		stateMutability: 'view',
		type: 'function'
	}
] as const;

/**
 * Unified contract ABI fragment for on-chain settlement verification.
 *
 * This ABI includes both function signatures to support version-agnostic resolution:
 *   - getPaymentContractState(uint32 paymentId) → V2 contracts
 *   - getEscrow(uint256 escrowId) → Legacy contracts
 *
 * The resolver automatically detects which function the contract supports.
 * 
 * @deprecated Use V2_PAYMENT_STATE_ABI or LEGACY_ESCROW_ABI for better type inference
 */
export const VERIFICATION_ABI = [...V2_PAYMENT_STATE_ABI, ...LEGACY_ESCROW_ABI] as const;

/**
 * On-chain state to ReviewBlockchainState mapping.
 * 
 * Unified mapping that works for all contract versions:
 *   0=Funded, 1=InDispute, 2=DisputeResolved, 3=DisputeUnresolved, 
 *   4=Completed, 5=Cancelled, 6=Refunded, 7=FundsReleased, 
 *   8=FundsClaimed, 9=NoShow, 10=WorkInProgress, 11=InDisputeWIP
 */
export const ONCHAIN_STATE_MAP = {
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
} as const;

export type OnchainStateValue = (typeof ONCHAIN_STATE_MAP)[keyof typeof ONCHAIN_STATE_MAP];
