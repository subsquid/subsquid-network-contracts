import {
  distributeRewards,
  epochLength,
  getBlockNumber,
  getBlockTimestamp,
  getRegistrations,
  nextEpochStart,
  Registrations
} from "./chain";
import {epochStats} from "./reward";

function getEpochStart(blockNumber: number, epochLength: number) {
  return blockNumber / epochLength * epochLength
}

async function earliestEpoch(registrations: Registrations) {
  const length = await epochLength()
  const firstRegistration = Math.min(...registrations.map(({registeredAt}) => Number(registeredAt)))
  const firsRegistrationEpoch = getEpochStart(firstRegistration, length)
  const nextEpoch = Number(await nextEpochStart())
  return Math.max(firsRegistrationEpoch, nextEpoch)
}

async function epochRanges() {
  const length = await epochLength()
  let currentEpochStart = await earliestEpoch(await getRegistrations())
  const current = getEpochStart(await getBlockNumber(), length)
  while (currentEpochStart + length < current) {
    console.log('EPOCH BLOCK', currentEpochStart)
    const rewards = await epochStats(await getBlockTimestamp(currentEpochStart), await getBlockTimestamp(currentEpochStart + length - 1));
    await distributeRewards(currentEpochStart + length, rewards)
    currentEpochStart += length
  }
  setTimeout(epochRanges, 60 * 1000)
}

epochRanges()
