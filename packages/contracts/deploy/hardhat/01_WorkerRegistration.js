// deploy/01_WorkerRegistration.js
const hre = require("hardhat");
const { ethers } = hre;
const { utils } = ethers;

function delay(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

const func = async function ({ deployments, getNamedAccounts }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Get the deployed tSQD contract address
  const tSQD = await deployments.get("tSQD");
  const tSQDAddress = tSQD.address;
  console.log("tSQD deployed at:", tSQDAddress);

  // Access the current network name and epochLengthBlocks value from the Hardhat configuration
  const networkName = hre.network.name;
  const epochLengthBlocks = hre.config.networks[networkName].epochLengthBlocks;

  console.log(`Network name: ${networkName}, epoch length blocks: ${epochLengthBlocks}, chainId: ${hre.config.networks[networkName].chainId}`)
  // Deploy the WorkerRegistration contract using the tSQD contract address
  console.log(`Waiting for new block`)
  await delay(1000);
  const salt = utils.id("worker-registration-salt");

  const workerRegistration = await deploy("WorkerRegistration", {
    from: deployer,
    args: [tSQDAddress, epochLengthBlocks],
    log: true,
    deterministicDeployment: salt,
  });

  console.log("WorkerRegistration deployed at:", workerRegistration.address);
};

module.exports = func;
func.tags = ["WorkerRegistration"];
func.dependencies = ["tSQD"];


