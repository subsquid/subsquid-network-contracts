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
  const workerRegistration = await deployments.get("WorkerRegistration");

  const salt = utils.id("reward-calculation-salt");

  const rewardCalculation = await deploy("RewardCalculation", {
    from: deployer,
    args: [workerRegistration.address],
    log: true,
    deterministicDeployment: salt,
  });

  console.log("RewardCalculation deployed at:", rewardCalculation.address);
};

module.exports = func;
func.tags = ["WorkerRegistration"];
func.dependencies = ["tSQD"];


