import type { Context, Next } from 'hono';

export async function corsMiddleware(c: Context, next: Next): Promise<Response | void> {
	const origin = c.req.header('Origin') || '';
	const allowedRaw = (c.env as Record<string, unknown>)?.ALLOWED_ORIGINS as string | undefined;
	const allowed = allowedRaw
		? allowedRaw.split(',').map((o) => o.trim()).filter(Boolean)
		: [];

	let effectiveOrigin = origin;
	if (allowed.length > 0) {
		effectiveOrigin = allowed.includes(origin) ? origin : allowed[0]!;
	}

	c.header('Access-Control-Allow-Origin', effectiveOrigin);
	c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	c.header('Access-Control-Max-Age', '86400');

	if (c.req.method === 'OPTIONS') {
		return c.body(null, 204);
	}

	return next();
}
