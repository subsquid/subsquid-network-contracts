import stream from 'stream';
import { captureException, captureMessage, init, NodeOptions, withScope } from '@sentry/node';
import { SeverityLevel } from '@sentry/types';

type ValueOf<T> = T extends any[] ? T[number] : T[keyof T];

export type SentryOptions = PinoSentryOptions & { app?: string };

class ExtendedError extends Error {
  public constructor(info: any) {
    super(info.message);
    this.name = 'Error';
    this.stack = info.stack || null;
  }
}

const SEVERITY_MAP: Record<number | string, SeverityLevel> = {
  10: 'debug', // pino: trace
  20: 'debug', // pino: debug
  30: 'info', // pino: info
  40: 'warning', // pino: warn
  50: 'error', // pino: error
  60: 'fatal', // pino: fatal
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warning: 'warning',
  error: 'error',
  fatal: 'fatal',
} as const;

const SeverityIota = {
  debug: 1,
  log: 2,
  info: 3,
  warning: 4,
  error: 5,
  fatal: 6,
  critical: 7,
} as const;

interface PinoSentryOptions extends NodeOptions {
  level?: keyof typeof SeverityIota;
  messageAttributeKey?: string;
}

export class PinoSentryTransport {
  minimumLogLevel: ValueOf<typeof SeverityIota> = SeverityIota.debug;
  messageAttributeKey = 'msg';

  public constructor(options?: SentryOptions) {
    init(this.validateOptions(options || {}));
  }

  public getLogSeverity(level: keyof typeof SEVERITY_MAP): SeverityLevel {
    return SEVERITY_MAP[level] || 'debug';
  }

  public send(chunk: any, cb: any): void {
    const severity = this.getLogSeverity(chunk.level);
    if (this.shouldLog(severity) === false) {
      setImmediate(cb);
      return;
    }

    const message = chunk[this.messageAttributeKey];
    const stack = chunk.error?.stack || chunk.err?.stack || chunk.stack || '';

    withScope(scope => {
      scope.clear();
      scope.setExtras(chunk);

      if (this.isSentryException(severity)) {
        const error = message instanceof Error ? message : new ExtendedError({ message, stack });
        captureException(error);
        cb();
      } else {
        captureMessage(message, severity);
        cb();
      }
    });
  }

  private validateOptions(options: SentryOptions): PinoSentryOptions {
    const dsn = options.dsn || process.env.SENTRY_DSN;
    if (!dsn) {
      console.log('Warning: [pino-sentry] Sentry DSN not supplied, logs will not be reported.');
    }
    if (options.level) {
      const allowedLevels = Object.keys(SeverityIota);
      if (allowedLevels.includes(options.level) === false) {
        throw new Error(`[pino-sentry] Option 'level' must be one of: ${allowedLevels.join(', ')}.`);
      }
      this.minimumLogLevel = SeverityIota[options.level];
    }

    this.messageAttributeKey = options.messageAttributeKey ?? this.messageAttributeKey;

    return {
      dsn,
      serverName: options.app,
      environment: options.environment,
      sampleRate: 1.0,
      maxBreadcrumbs: 100,
      ...options,
    };
  }

  private isSentryException(level: SeverityLevel): boolean {
    return level === 'fatal' || level === 'error';
  }

  private shouldLog(severity: SeverityLevel): boolean {
    const logLevel = SeverityIota[severity];
    return logLevel >= this.minimumLogLevel;
  }
}

export function createSentryTransport(options?: SentryOptions) {
  const transport = new PinoSentryTransport(options);
  return new stream.Writable({
    autoDestroy: true,
    write(chunk, enc, cb) {
      transport.send(JSON.parse(chunk.toString('utf-8')), cb);
    },
  });
} 