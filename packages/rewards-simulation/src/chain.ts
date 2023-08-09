import {contracts} from "./config";
import {l1Client, publicClient} from "./client";
import {parseAbiItem} from "viem";

export async function getRegistrations() {
  return (await publicClient.getLogs({
    address: contracts.workerRegistration.address,
    event: parseAbiItem('event WorkerRegistered(uint256 indexed workerId, bytes indexed peerId, address indexed registrar, uint256 registeredAt)'),
    fromBlock: 1n,
  })).map(({args}) => args)
}

export type Registrations = Awaited<ReturnType<typeof getRegistrations>>

export async function epochLength() {
  // Approx 1 day on Goerli
  return 3000
  // return Number(await contracts.workerRegistration.read.epochLength())
}

export async function bond() {
  return contracts.workerRegistration.read.BOND_AMOUNT()
}

export async function getBlockNumber() {
  return Number(await l1Client.getBlockNumber())
}

export async function getBlockTimestamp(blockNumber: number) {
  return new Date(Number((await l1Client.getBlock({
    blockNumber: BigInt(blockNumber),
  })).timestamp) * 1000)
}
