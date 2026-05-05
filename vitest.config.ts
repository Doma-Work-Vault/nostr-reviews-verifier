import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@bittasker/reviews-contracts': new URL('./packages/reviews-contracts/src/index.ts', import.meta.url).pathname
		}
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		globals: true
	}
});
