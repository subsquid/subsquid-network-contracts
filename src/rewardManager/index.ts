import {publicClient} from "./client";
import {contracts} from "./config";

let nextEpochBlock = 0n

async function getBlockNumber() {
  return publicClient.getBlockNumber()
}

async function distribute(reward: bigint) {
  let rewardLeft = reward
  const workers = await contracts.workerRegistration.read.getActiveWorkers();
  const workerAddresses = workers.map((worker) => worker.creator);
  const amounts = workerAddresses.map((_, i) => {
    const left = workerAddresses.length - i
    const workerReward = reward / BigInt(left)
    rewardLeft -= workerReward
    return workerReward
  })
  const t = await contracts.rewardsDistribution.write.distribute([workerAddresses, amounts, reward], {})
  console.log(t)
}

async function run() {
  if (await getBlockNumber() > nextEpochBlock) {
    nextEpochBlock = await contracts.workerRegistration.read.nextEpoch()
    console.log('APY', await contracts.rewardCalculation.read.currentApy([900n]));
    console.log('REWARD', await contracts.rewardCalculation.read.epochReward([900n]));
    console.log('Next epoch block: ', nextEpochBlock)
    await distribute(await contracts.rewardCalculation.read.epochReward([900n]))
  }
  setTimeout(run, 1000)
}

run()
