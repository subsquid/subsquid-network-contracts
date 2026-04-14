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

function shortenHex(value: string): string {
  if (!value.startsWith('0x') || value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function extractWithRegex(value: string | undefined, pattern: RegExp): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(pattern);
  return match?.[1];
}

function buildCompactMessage(record: Record<string, unknown> | undefined, message: string): string {
  const functionName =
    getStringField(record, 'functionName') ||
    extractWithRegex(message, /function:\s+([a-zA-Z0-9_]+\([^)]*\))/i);
  const contractAddress =
    getStringField(record, 'contractAddress') ||
    extractWithRegex(message, /\bto:\s+(0x[a-fA-F0-9]{40})/i) ||
    extractWithRegex(message, /\baddress:\s+(0x[a-fA-F0-9]{40})/i);
  const selector = extractWithRegex(message, /\bdata:\s+(0x[a-fA-F0-9]{8})/i);

  if (message.includes('Cannot decode zero data ("0x")')) {
    if (functionName && contractAddress) {
      return `Empty RPC response for ${functionName} on ${shortenHex(contractAddress)}`;
    }
    if (functionName) {
      return `Empty RPC response for ${functionName}`;
    }
    return 'Empty RPC response while reading contract';
  }

  if (message === 'HTTP request failed.' || message.startsWith('HTTP request failed.')) {
    const details = getStringField(record, 'details');
    return details ? `HTTP request failed: ${details}` : message;
  }

  if (functionName && contractAddress) {
    return `${message} (${functionName} on ${shortenHex(contractAddress)})`;
  }
  if (functionName) {
    return `${message} (${functionName})`;
  }
  if (selector) {
    return `${message} (${selector})`;
  }

  return message;
}

function compactSerializedError(error: unknown) {
  if (error == null) {
    return undefined;
  }

  const record = asRecord(error);
  const rawMessage =
    getStringField(record, 'shortMessage') ||
    getStringField(record, 'message') ||
    (error instanceof Error ? error.message : String(error));
  const message = buildCompactMessage(record, rawMessage);

  const compact: Record<string, string> = {
    name:
      getStringField(record, 'name') ||
      (error instanceof Error ? error.name : 'Error'),
    message,
  };

  const details = getStringField(record, 'details');
  if (details && details !== rawMessage && details !== message) {
    compact.details = details;
  }

  const code = getStringField(record, 'code');
  if (code) {
    compact.code = code;
  }

  const functionName = getStringField(record, 'functionName');
  if (functionName) {
    compact.function = functionName;
  }

  const contractAddress = getStringField(record, 'contractAddress');
  if (contractAddress) {
    compact.contract = shortenHex(contractAddress);
  }

  const selector =
    extractWithRegex(rawMessage, /\bdata:\s+(0x[a-fA-F0-9]{8})/i) ||
    extractWithRegex(getStringField(asRecord(record?.cause), 'message'), /\bdata:\s+(0x[a-fA-F0-9]{8})/i);
  if (selector) {
    compact.selector = selector;
  }

  const cause = getStringField(asRecord(record?.cause), 'message');
  if (cause && cause !== rawMessage && cause !== message) {
    compact.cause = buildCompactMessage(asRecord(record?.cause), cause);
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
