import pino from 'pino';
import dayjs from 'dayjs';
import pinoms, { Level, prettyStream, Streams } from 'pino-multi-stream';

const shouldLog = () => process.env.VERBOSE === "true";
const prettyLog = process.env.DISABLE_PRETTY_PRINT === undefined && process.stdout.isTTY;
const logLevel = (process.env.LOG_LEVEL || 'debug') as Level;

export type CtxValue = Record<string, string | number>

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
      : pino.destination(process.stdout),
  },
];

const pino_logger = pinoms({
  base: null,
  level: logLevel,
  streams,
  timestamp: prettyLog
    ? () => `,"time":"${dayjs(new Date()).format('HH:mm:ss.SSS')}"`
    : () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  serializers: {
    error: e => pino.stdSerializers.err(e),
    err: e => pino.stdSerializers.err(e),
  },
})


export class Context {
  value: CtxValue
  logger: pinoms.Logger

  constructor(value: CtxValue = {}) {
    this.value = value;
    this.logger = pino_logger.child(value);
  }

  child(value: CtxValue) {
    return new Context({ ...this.value, ...value });
  }
}

function logWithWorkerAddress(
  workerAddress: string,
  fun: "log" | "error",
  ...args: any[]
) {
  if (workerAddress !== "") {
    console[fun](`[${workerAddress}]`, ...args);
  } else {
    console[fun](...args);
  }
}

export const logger = {
  log(...args: any[]) {
    shouldLog() && logWithWorkerAddress(this.workerAddress, "log", ...args);
  },
  error(...args: any[]) {
    shouldLog() && logWithWorkerAddress(this.workerAddress, "error", ...args);
  },
  table: (...args: any[]) => shouldLog() && console.table(...args),
  workerAddress: "",
};
