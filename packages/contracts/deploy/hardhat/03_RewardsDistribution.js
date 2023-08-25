const hre = require("hardhat");
const { ethers } = hre;
const { utils } = ethers;

const func = async function ({ deployments, getNamedAccounts }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Get the deployed tSQD contract address
  const workerRegistration = await deployments.get("WorkerRegistration");
  const tsqd = await deployments.get("tSQD");

  const salt = utils.id("reward-distribution-salt");

  const rewardDistribution = await deploy("RewardsDistribution", {
    from: deployer,
    args: [deployer, workerRegistration.address],
    log: true,
    deterministicDeployment: salt,
  });
  const distributionContract = await ethers.getContractAt("RewardsDistribution", rewardDistribution.address);
  await distributionContract.grantRole(await distributionContract.REWARDS_DISTRIBUTOR_ROLE(), deployer)
  const rewardTreasury = await deploy("RewardTreasury", {
    from: deployer,
    args: [deployer, tsqd.address],
    log: true,
    deterministicDeployment: salt,
  });
  await distributionContract.grantRole(await distributionContract.REWARDS_TREASURY_ROLE(), rewardTreasury.address)
  console.log("RewardCalculation deployed at:", rewardDistribution.address);
};

module.exports = func;
func.tags = ["WorkerRegistration"];
func.dependencies = ["tSQD"];


