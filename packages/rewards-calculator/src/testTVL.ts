import { BlockTag, createPublicClient, http } from 'viem';
import { addresses, contracts } from './config';
import { logger } from './logger';
import { currentApy, getFirstBlockForL1Block } from './chain';

export async function currentApyTest(blockNumber?: number) {
  let l2block: bigint | undefined;
  if (blockNumber) {
    l2block = await getFirstBlockForL1Block(blockNumber)
  }

  const l2blockNumber = l2block ? BigInt(l2block) : undefined
  try {
    //Directly read from the contract using the public client
    // const tvl = await client.readContract({
    //   address: addresses.rewardCalculation,
    //   abi,
    //   functionName: 'effectiveTVL',
    //   l2blockNumber,
    // }) as bigint;
    console.log(`l1 block number: ${blockNumber}`)
    console.log(`l2 block number: ${l2blockNumber}`)
    const tvl = await contracts.rewardCalculation.read.effectiveTVL({blockNumber: l2blockNumber});

    if (tvl === 0n) {
      return 2000n;
    }

    // const initialRewardPoolsSize = await client.readContract({
    //   address: addresses.rewardCalculation,
    //   abi,
    //   functionName: 'INITIAL_REWARD_POOL_SIZE',
    //   blockNumber,
    // }) as bigint;

    const initialRewardPoolsSize = await contracts.rewardCalculation.read.INITIAL_REWARD_POOL_SIZE({blockNumber: l2blockNumber});
  

    // const yearlyRewardCapCoefficient = await client.readContract({
    //   address: addresses.networkController,
    //   abi,
    //   functionName: 'yearlyRewardCapCoefficient',
    //   blockNumber,
    // }) as bigint;

    const yearlyRewardCapCoefficient = await contracts.networkController.read.yearlyRewardCapCoefficient({blockNumber: l2blockNumber});
    logger.log(`Yearly Reward Cap Coefficient: ${yearlyRewardCapCoefficient.toString()}`);


    const apyCap =
      (BigInt(10000) * yearlyRewardCapCoefficient * initialRewardPoolsSize) / tvl;

    console.log(`Apy Cap: ${apyCap.toString()}`);

    return apyCap > 2000n ? 2000n : apyCap;
  } catch (error) {
    console.error('Error calculating APY:', error);
    throw error;
  }
}

(async () => {
  console.log(`APY: ${await currentApy(21279057n)}`)
  console.log(`APY: ${await currentApy(21279057)}`)
  console.log(`APY: ${await currentApy(21279057n)}`)
  console.log(`APY: ${await currentApy(21279057)}`)
  console.log(`APY: ${await currentApy(21279057n)}`)
  console.log(`APY: ${await currentApy(21279057)}`)
})().then(() => console.log('Done'))
 
