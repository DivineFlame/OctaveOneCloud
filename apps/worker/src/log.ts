import { redact } from '@ooc/shared';

type Level = 'error' | 'warn' | 'info' | 'debug';
const order: Level[] = ['error', 'warn', 'info', 'debug'];
const min = (process.env.LOG_LEVEL as Level) ?? 'info';

export function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (order.indexOf(level) > order.indexOf(order.includes(min) ? min : 'info')) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'worker', msg, data: data ? redact(data) : undefined });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
