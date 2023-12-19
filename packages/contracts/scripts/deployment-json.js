import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dirs = fs.readdirSync(`${__dirname}/../broadcast/Deploy.s.sol`);

for (const dir of dirs) {
  const latestRun = JSON.parse(
    fs
      .readFileSync(
        `${__dirname}/../broadcast/Deploy.s.sol/${dir}/run-latest.json`
      )
      .toString()
  );
  const contracts = latestRun.transactions
    .filter((tx) => tx.transactionType === "CREATE")
    .map((tx) => [tx.contractName, tx.contractAddress]);
  fs.writeFileSync(
    `${__dirname}/../deployments/${dir}.json`,
    JSON.stringify(Object.fromEntries(contracts), null, 2)
  );
}
