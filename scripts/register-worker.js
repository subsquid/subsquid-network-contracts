const { ethers } = require('ethers');
const bs58 = require('bs58');
const fs = require("fs");

const RPC_PROVIDER_URL = process.env.RPC_PROVIDER_URL || 'http://127.0.0.1:8545'
console.log(`Using RPC: ${RPC_PROVIDER_URL}`)

const NETWORK_NAME=process.env.NETWORK_NAME || 'localhost'

const SUPPORTED_NETWORKS = ['localhost', 'arbitrum-goerli']

if (!SUPPORTED_NETWORKS.includes(NETWORK_NAME)) {
  console.error(`Unsupported network ${NETWORK_NAME}. Supported networks: ${SUPPORTED_NETWORKS}`);
  process.exit(1);
}

console.log(`Using network ${NETWORK_NAME}`)

const wrDeployArtifact = JSON.parse(fs.readFileSync(`./deployments/${NETWORK_NAME}/WorkerRegistration.json`, "utf8"));
const workerRegistrationAddress = wrDeployArtifact.address;
const workerRegistrationABI = wrDeployArtifact.abi;

const tSQDArtifact = JSON.parse(fs.readFileSync(`./deployments/${NETWORK_NAME}/tSQD.json`, "utf8"));
const tSQDTokenAddress = tSQDArtifact.address;
const tSQDTokenABI = tSQDArtifact.abi;

if (process.argv.length < 4) {
  console.error('Usage: node register-worker.js [base58PeerID] [privateKey]');
  process.exit(1);
}

const base58PeerID = process.argv[2];
const privateKey = process.argv[3];

const registerWorker = async () => {
  // Connect to the network using the provided private key
  const provider = new ethers.providers.JsonRpcProvider(RPC_PROVIDER_URL);
  const wallet = new ethers.Wallet(privateKey, provider);

  // Decode the base58-encoded PeerID and zero-pad if necessary
  const decodedPeerID = bs58.decode(base58PeerID);

  // Connect to the WorkerRegistration contract
  const workerRegistrationContract = new ethers.Contract(workerRegistrationAddress, workerRegistrationABI, wallet);
  const tSQDTokenContract = new ethers.Contract(tSQDTokenAddress, tSQDTokenABI, wallet);

  try {
    const balance =  await tSQDTokenContract.balanceOf(wallet.address);
    console.log("tSQD balance:", ethers.utils.formatUnits(balance, 18));
    // approve
    console.log("Approving SQD spend");
    const requiredAmount = ethers.utils.parseUnits("100000", 18); // Replace with the required amount
    const approveTx = await tSQDTokenContract.approve(workerRegistrationContract.address, requiredAmount);
    await approveTx.wait();
    console.log("Approve done");
    // Register the worker
    console.log("Registering");
    const tx = await workerRegistrationContract.register(decodedPeerID);
    await tx.wait();

    console.log(`Worker with PeerID ${base58PeerID} registered successfully.`);
  } catch (err) {
    console.error('Error registering worker:', err.message);
  }
};

registerWorker();
