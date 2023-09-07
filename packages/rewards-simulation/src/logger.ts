const shouldLog = process.env.VERBOSE === 'true'

export const logger = {
  log: (...args: any[]) => shouldLog && console.log(...args),
  table: (...args: any[]) => shouldLog && console.table(...args),
}
