type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info').trim().toLowerCase() as Level] ?? LEVELS.info;

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const timestamp = new Date().toISOString();
  const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  const line = `[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
