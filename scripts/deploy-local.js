const hre = require("hardhat");
const fs = require("fs");

const { ethers } = hre

const networkConfig = hre.network.config;
const epochLengthBlocks = networkConfig.epochLengthBlocks;

async function main() {
  const [deployer, ...workers] = await ethers.getSigners();
  const tSQDTokenFactory = await ethers.getContractFactory("tSQD");
  const deployerAddress = deployer.address;
  const recipients = [deployerAddress];
  const percentages = [100];
  const tSQDToken = await tSQDTokenFactory.deploy(recipients, percentages);
  await tSQDToken.deployed();
  console.log("tSQD Token deployed to:", tSQDToken.address);
  
  const WorkerRegistrationContract = await ethers.getContractFactory("WorkerRegistration");
  const workerRegistration = await WorkerRegistrationContract.deploy(tSQDToken.address, epochLengthBlocks);
  await workerRegistration.deployed();
  console.log("WorkerRegistration deployed to:", workerRegistration.address);

  const contractAddresses = {
    tSQDToken: tSQDToken.address,
    WorkerRegistration: workerRegistration.address,
  };
  
  fs.writeFileSync("contract-addresses.json", JSON.stringify(contractAddresses, null, 2));
  console.log("Contract addresses saved to contract-addresses.json");

  const amount = ethers.utils.parseUnits("100000", 18);

  for (let i = 0; i < 10; i++) {
    await tSQDToken.transfer(workers[i].address, amount);
    console.log(`Transferred 100000 tSQD to: ${workers[i].address}`);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});