import { startBot } from "./startBot";

const n: number = Number(process.argv[2]);

(async () => {
  for (let i = 0; i < n; i++) {
    await startBot(i);
  }
})();
