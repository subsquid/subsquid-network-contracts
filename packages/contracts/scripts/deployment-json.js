const fs = require('fs');

const dirs = fs.readdirSync(`${__dirname}/../broadcast/Deploy.s.sol`)

for (const dir of dirs) {
  const latestRun = JSON.parse(fs.readFileSync(`${__dirname}/../broadcast/Deploy.s.sol/${dir}/run-latest.json`).toString())
  const contracts = latestRun.transactions.filter(tx => tx.transactionType === 'CREATE').map(tx => [tx.contractName, tx.contractAddress])
  fs.writeFileSync(`${__dirname}/../deployments/${dir}.json`, JSON.stringify(Object.fromEntries(contracts), null, 2))
}
