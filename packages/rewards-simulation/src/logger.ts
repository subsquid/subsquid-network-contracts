const shouldLog = process.env.VERBOSE === "true";

export const logger = {
  log: (...args: any[]) => shouldLog && console.log(...args),
  error: (...args: any[]) => shouldLog && console.error(...args),
  table: (...args: any[]) => shouldLog && console.table(...args),
};
