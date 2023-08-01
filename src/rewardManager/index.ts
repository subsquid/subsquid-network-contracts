import {publicClient} from "./client";
import {contracts} from "./config";

let nextEpochBlock = 0n

async function getBlockNumber() {
  return publicClient.getBlockNumber()
}

async function run() {
  if (await getBlockNumber() > nextEpochBlock) {
    nextEpochBlock = await contracts.workerRegistration.read.nextEpoch()
    console.log('APY', await contracts.rewardCalculation.read.currentApy([900n]));
    console.log('REWARD', await contracts.rewardCalculation.read.epochReward([900n]));
    console.log('Next epoch block: ', nextEpochBlock)
  }
  setTimeout(run, 1000)
}

run()
