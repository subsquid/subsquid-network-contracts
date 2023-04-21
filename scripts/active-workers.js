const {ethers, utils} = require("ethers");
const bs58 = require('bs58');
const fs = require('fs')

const wrDeployArtifact = JSON.parse(fs.readFileSync("./deployments/localhost/WorkerRegistration.json", "utf8"));
const workerRegistrationAddress = wrDeployArtifact.address;
const workerRegistrationABI = wrDeployArtifact.abi;

// Connect to the network
const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545/');
// Connect to the WorkerRegistration contract
const workerRegistrationContract = new ethers.Contract(workerRegistrationAddress, workerRegistrationABI, provider);

function toBase58(worker) {
    const peerIdBytes = utils.concat([worker.peerId[0], worker.peerId[1]]);
    return bs58.encode(utils.arrayify(peerIdBytes));
} 

const decodeWorker = (worker) => ({
    account: worker.account,
    peerId: toBase58(worker),
    bond: worker.bond.toString(),
    registeredAt: worker.registeredAt.toString(),
    deregisteredAt: worker.deregisteredAt.toString()
})

const getActiveWorkers = async () => {
  const allCount = await workerRegistrationContract.getAllWorkersCount();
  console.log("All workers cnt:", allCount);
  
  for (i=0; i < allCount; i++) {
    const w = await workerRegistrationContract.getWorkerByIndex(i);
    console.log(`Worker ${i}`, decodeWorker(w))
  }

  const activeWorkerCount = await workerRegistrationContract.getActiveWorkerCount();
  console.log("Active worker count:", activeWorkerCount.toString());

  // Call the getActiveWorkers() function
  const activeWorkers = await workerRegistrationContract.getActiveWorkers();

  // Process the workers and convert their peerIds back to base58
  const processedWorkers = activeWorkers.map(w => decodeWorker(w));

  console.log('Active Workers:', processedWorkers);
  
};


getActiveWorkers();
