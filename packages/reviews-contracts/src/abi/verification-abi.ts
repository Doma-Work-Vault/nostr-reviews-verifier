/**
 * Minimal V2 contract ABI fragment for on-chain settlement verification.
 *
 * This is the only function we need to call for review attestation:
 *   getPaymentContractState(uint32 paymentId) → (uint8 state, bool exists, address tasker, address taskee, bool noShowMarked)
 *
 * The full V2 ABI (~16 KB) is NOT copied here — only the ~500 byte fragment needed for verification.
 */
export const VERIFICATION_ABI = [
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
