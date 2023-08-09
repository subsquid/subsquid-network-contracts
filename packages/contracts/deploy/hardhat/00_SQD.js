const hre = require("hardhat");
const ethers = hre.ethers;

const func = async function ({ deployments, getNamedAccounts }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("Deployer address:", deployer); // Add this line to check the deployer's address

  const tSQD = await deploy("tSQD", {
    from: deployer,
    args: [[deployer], [100]], // 100% allocation to the deployer
    log: true,
  });

  const tSQDContract = await ethers.getContractAt("tSQD", tSQD.address);
  const amount = ethers.utils.parseUnits("150000", 18);

  const signers = await ethers.getSigners();

  for (let i = 1; i <= 10; i++) {
    await tSQDContract.transfer(signers[i].address, amount);
    console.log(`Transferred 150000 tSQD to: ${signers[i].address}`);
  }

};

module.exports = func;
func.tags = ["tSQD"];
