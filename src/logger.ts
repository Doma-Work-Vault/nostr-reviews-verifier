export interface Logger {
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, error?: Error, meta?: Record<string, unknown>): void;
}

function formatLog(level: string, msg: string, meta?: Record<string, unknown>, error?: Error): string {
	return JSON.stringify({
		level,
		timestamp: Date.now(),
		message: msg,
		...(error ? { error: error.message } : {}),
		...(meta ?? {})
	});
}

export const structuredLogger: Logger = {
	info(msg: string, meta?: Record<string, unknown>) {
		console.log(formatLog('info', msg, meta));
	},
	warn(msg: string, meta?: Record<string, unknown>) {
		console.warn(formatLog('warn', msg, meta));
	},
	error(msg: string, error?: Error, meta?: Record<string, unknown>) {
		console.error(formatLog('error', msg, meta, error));
	}
};

export class CountingLogger implements Logger {
	public infoCount = 0;
	public warnCount = 0;
	public errorCount = 0;

	info(msg: string, meta?: Record<string, unknown>) {
		this.infoCount++;
		structuredLogger.info(msg, meta);
	}
	warn(msg: string, meta?: Record<string, unknown>) {
		this.warnCount++;
		structuredLogger.warn(msg, meta);
	}
	error(msg: string, error?: Error, meta?: Record<string, unknown>) {
		this.errorCount++;
		structuredLogger.error(msg, error, meta);
	}
}
