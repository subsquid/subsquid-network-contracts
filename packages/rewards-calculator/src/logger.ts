const shouldLog = () => process.env.VERBOSE === "true";

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
