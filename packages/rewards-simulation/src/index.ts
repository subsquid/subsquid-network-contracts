import {epochLength, getBlockNumber, getBlockTimestamp, getRegistrations, Registrations} from "./chain";
import {epochStats} from "./reward";

function getEpochStart(blockNumber: number, epochLength: number) {
  return blockNumber / epochLength * epochLength
}

async function earliestEpoch(registrations: Registrations) {
  const length = await epochLength()
  const firstRegistration = Math.min(...registrations.map(({registeredAt}) => Number(registeredAt)))
  return getEpochStart(firstRegistration, length)
}

async function epochRanges() {
  const length = await epochLength()
  let currentEpochStart = await earliestEpoch(await getRegistrations())
  const current = getEpochStart(await getBlockNumber(), length)
  let i = 0
  while (currentEpochStart + length < current) {
    console.log('EPOCH', i++)
    await epochStats(await getBlockTimestamp(currentEpochStart), await getBlockTimestamp(currentEpochStart + length - 1));
    currentEpochStart += length
  }
}

epochRanges()
