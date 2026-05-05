import type { Context, Next } from 'hono';

export function createRateLimitHeadersMiddleware(getLimit: () => { limit: number; remaining: number; reset: number }) {
	return async (c: Context, next: Next) => {
		await next();

		const { limit, remaining, reset } = getLimit();
		c.header('X-RateLimit-Limit', limit.toString());
		c.header('X-RateLimit-Remaining', remaining.toString());
		c.header('X-RateLimit-Reset', reset.toString());
	};
}
