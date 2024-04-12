import { epochStats } from "./reward";
process.env.VERBOSE = "true";
const [, , fromBlock, toBlock] = process.argv.map(Number);
const workers = await epochStats(fromBlock, toBlock);
await workers.printLogs();
