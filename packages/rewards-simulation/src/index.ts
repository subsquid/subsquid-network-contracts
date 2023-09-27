import {
  approveRewards,
  canCommit,
  commitRewards,
  epochLength,
  getBlockNumber,
  getBlockTimestamp,
  getRegistrations,
  lastRewardedBlock,
  nextEpochStart,
  Registrations, watchCommits
} from "./chain";
import {epochStats} from "./reward";
import {hasNewerPings} from "./logs";

function getEpochStart(blockNumber: number, epochLength: number) {
  return Math.floor(blockNumber / epochLength) * epochLength
}

async function firstRegistrationBlock(registrations: Registrations) {
  return Math.min(...registrations.map(({registeredAt}) => Number(registeredAt)))
}

async function earliestEpoch(registrations: Registrations) {
  const length = await epochLength()
  const firstRegistration = Math.min(...registrations.map(({registeredAt}) => Number(registeredAt)))
  const firsRegistrationEpoch = getEpochStart(firstRegistration, length)
  const nextEpoch = Number(await nextEpochStart())
  return Math.max(firsRegistrationEpoch, nextEpoch)
}

// async function epochRanges() {
//   const length = await epochLength()
//   let currentEpochStart = await earliestEpoch(await getRegistrations())
//   const current = getEpochStart(await getBlockNumber(), length)
//   while (currentEpochStart + length < current) {
//     console.log('EPOCH BLOCK', currentEpochStart)
//     const rewards = await epochStats(await getBlockTimestamp(currentEpochStart), await getBlockTimestamp(currentEpochStart + length - 1));
//     await commitRewards(currentEpochStart + length, rewards)
//     currentEpochStart += length
//   }
//   setTimeout(epochRanges, 60 * 1000)
// }

commitIfPossible()
watchCommits(async (args) => {
  const rewards = await epochStats(await getBlockTimestamp(args.fromBlock), await getBlockTimestamp(args.toBlock))
  await approveRewards(args.fromBlock, args.toBlock, rewards)
})

async function commitIfPossible() {
  if (await canCommit()) {
    let _lastRewardedBlock = await lastRewardedBlock()
    if (_lastRewardedBlock === 0) {
      _lastRewardedBlock = await firstRegistrationBlock(await getRegistrations())
    }
    const currentEpochStart = getEpochStart(await getBlockNumber(), await epochLength())

    if (_lastRewardedBlock < currentEpochStart && await hasNewerPings(await getBlockTimestamp(currentEpochStart - 1))) {
      const rewards = await epochStats(await getBlockTimestamp(_lastRewardedBlock), await getBlockTimestamp(currentEpochStart - 1))
      await commitRewards(_lastRewardedBlock, currentEpochStart - 1, rewards)
      setTimeout(commitIfPossible, 10 * 60 * 1000)
    }
  } else {
    setTimeout(commitIfPossible, 60 * 1000)
  }
}
