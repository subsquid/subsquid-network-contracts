import { LogLevel } from '@nestjs/common';
import { format } from 'date-fns';
import pino from 'pino';
import pinoms, { Level, prettyStream, Streams } from 'pino-multi-stream';
import { createSentryTransport } from './pino-sentry';

const prettyLog = process.env.NODE_ENV !== 'production';
const logLevel = (process.env.LOG_LEVEL || 'debug') as Level;

export type Logger = pinoms.Logger;

let loggerInstance: Logger;

function getStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  if (typeof field === 'string' && field.trim().length > 0) {
    return field;
  }
  if (
    typeof field === 'number' ||
    typeof field === 'bigint' ||
    typeof field === 'boolean'
  ) {
    return String(field);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSerializedError(error: unknown) {
  if (error == null) {
    return undefined;
  }

  const record = asRecord(error);
  const message =
    getStringField(record, 'shortMessage') ||
    getStringField(record, 'message') ||
    (error instanceof Error ? error.message : String(error));

  const compact: Record<string, string> = {
    name:
      getStringField(record, 'name') ||
      (error instanceof Error ? error.name : 'Error'),
    message,
  };

  const details = getStringField(record, 'details');
  if (details && details !== message) {
    compact.details = details;
  }

  const code = getStringField(record, 'code');
  if (code) {
    compact.code = code;
  }

  const cause = getStringField(asRecord(record?.cause), 'message');
  if (cause && cause !== message) {
    compact.cause = cause;
  }

  return compact;
}

export const Logger = {
  get() {
    return loggerInstance;
  },
};

export function initializeLogger(appName: string) {
  if (loggerInstance) return loggerInstance;

  const streams: Streams = [
    {
      level: logLevel,
      stream: prettyLog
        ? prettyStream({
            prettyPrint: {
              messageKey: 'message',
              singleLine: true,
            },
          })
        : process.stdout,
    },
  ];

  if (process.env.SENTRY_DSN) {
    streams.push({
      level: 'error',
      stream: createSentryTransport({
        app: appName,
        dsn: process.env.SENTRY_DSN,
        messageAttributeKey: 'message',
        environment: `${process.env.ENV || 'unknown'}`,
        level: 'error',
      }),
    });
  }

  loggerInstance = pinoms({
    base: null,
    level: logLevel,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    messageKey: 'message',
    timestamp: prettyLog
      ? () => `,"time":"${format(new Date(), 'HH:mm:ss.SSS')}"`
      : () => `,"timestamp":"${new Date().toISOString()}"`,
    serializers: {
      error: compactSerializedError,
      err: compactSerializedError,
    },
    streams,
  });

  return loggerInstance;
}

export const nestJsLogger = {
  error(message: any, stack: any, ...rest: any[]) {
    const err = new Error(message);
    err.stack = stack;
    loggerInstance.error({ message: 'NestJS error log', error: err });
  },
  log(message: any, module: string, ...optionalParams: any[]) {
    if (module === 'InstanceLoader') return;
    if (optionalParams.length) {
      loggerInstance.debug({ message, params: optionalParams });
    } else {
      loggerInstance.debug(message);
    }
  },
  warn(message: any, module: string, ...optionalParams: any[]) {
    loggerInstance.warn({ message, params: optionalParams });
  },
  debug(message: any, module: string, ...optionalParams: any[]) {
    loggerInstance.debug({ message, params: optionalParams });
  },
  setLogLevels(levels: LogLevel[]): any {},
};
