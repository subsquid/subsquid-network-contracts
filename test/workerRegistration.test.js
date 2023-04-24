const { expect } = require("chai");
const { ethers } = require("hardhat");
const sinon = require("sinon");


describe("WorkerRegistration", function () {
  let workerRegistration, tSQD, owner, addr1, addr2;

  beforeEach(async () => {
    // Deploy tSQD token contract
    [owner, addr1, addr2] = await ethers.getSigners();

    const tSQDToken = await ethers.getContractFactory("tSQD");
    tSQD = await tSQDToken.deploy([owner.address, addr1.address, addr2.address], [80, 10, 10]);
    await tSQD.deployed();

    // Deploy WorkerRegistration contract
    const WorkerRegistration = await ethers.getContractFactory("WorkerRegistration");
    workerRegistration = await WorkerRegistration.deploy(tSQD.address, 1);
    await workerRegistration.deployed();

    console.log('Deployed')

    await tSQD.connect(owner).approve(workerRegistration.address, ethers.utils.parseEther("1000000"));
    await tSQD.connect(addr1).approve(workerRegistration.address, ethers.utils.parseEther("1000000"));
    await tSQD.connect(addr2).approve(workerRegistration.address, ethers.utils.parseEther("1000000"));

    console.log(`Approvals granted`)
  });

  it("should reject registration if worker is already registered", async function () {
    const peerId = [ethers.utils.formatBytes32String("test-peer-id-1"), ethers.utils.formatBytes32String("test-peer-id-2")];

    const tx = await workerRegistration.connect(addr1).register(peerId);
    await tx.wait(); 
    console.log(`Registered ${addr1.address}`)
    console.log(`Worker ID: ${await workerRegistration.workerIds(addr1.address)}`);
    
    await expect(workerRegistration.connect(addr1).register(peerId)).to.be.revertedWith("Worker already registered")

  });

  it("should emit WorkerRegistered event on registration", async function () {
    const peerId = [ethers.utils.formatBytes32String("test-peer-id-1"), ethers.utils.formatBytes32String("test-peer-id-2")];

    const lastBlock = await hre.ethers.provider.getBlock("latest")
    // mined at latestBlock + 1, next epoch will start at lastBlock + 2
    await expect(workerRegistration.connect(addr1).register(peerId))
      .to.emit(workerRegistration, "WorkerRegistered")
      .withArgs(1, addr1.address, peerId[0], peerId[1], lastBlock.number + 2);
});

  // Add more tests here

});
