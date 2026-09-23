import { LoggerService } from '@nestjs/common';
import { redact } from '@ooc/shared';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];

/** Structured JSON logger with mandatory redaction of credentials. */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: Level = 'info', private readonly service = 'api') {}

  private write(level: Level, message: unknown, context?: string, extra?: unknown) {
    if (LEVELS.indexOf(level) > LEVELS.indexOf(this.minLevel)) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      context,
      msg: typeof message === 'string' ? message : undefined,
      data: typeof message === 'string' ? redact(extra) : redact(message),
    };
    const line = JSON.stringify(entry);
    if (level === 'error' || level === 'fatal') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  log(message: unknown, context?: string) { this.write('info', message, context); }
  error(message: unknown, trace?: string, context?: string) { this.write('error', message, context, trace ? { trace } : undefined); }
  warn(message: unknown, context?: string) { this.write('warn', message, context); }
  debug(message: unknown, context?: string) { this.write('debug', message, context); }
  verbose(message: unknown, context?: string) { this.write('trace', message, context); }
  fatal(message: unknown, context?: string) { this.write('fatal', message, context); }
}
