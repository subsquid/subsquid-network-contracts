import { startWorker } from "./start-worker";
import { epochStats } from "./reward";

const n: number = Number(process.argv[2]);

// (async () => {
//   for (let i = 0; i < n; i++) {
//     await startWorker(i);
//   }
// })();
(async () => {
  await epochStats(
    new Date("Oct 14 2023, 12:40:24 PM"),
    new Date("Oct 15 2023, 1:05:48 AM"),
  );
  await epochStats(
    new Date("Oct 15 2023, 1:06:00 AM"),
    new Date("Oct 15 2023, 1:32:00 AM"),
  );
})();
