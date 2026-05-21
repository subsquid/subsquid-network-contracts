import { LogLevel } from '@nestjs/common';
import { format } from 'date-fns';
import pino from 'pino';
import pinoms, { Level, prettyStream, Streams } from 'pino-multi-stream';
import { createSentryTransport } from './pino-sentry';

const prettyLog = process.env.NODE_ENV !== 'production';
const logLevel = (process.env.LOG_LEVEL || 'debug') as Level;

export type Logger = pinoms.Logger;

let loggerInstance: Logger;

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
      error: pinoms.stdSerializers.err,
      err: pinoms.stdSerializers.err,
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
