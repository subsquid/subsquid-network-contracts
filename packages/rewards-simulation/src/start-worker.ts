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
import {createWalletClient, fromHex, http, parseEther, publicActions, toHex, WalletClient} from "viem";
import {arbitrumGoerli} from "viem/chains";
import {privateKeyToAccount} from "viem/accounts";
import {logger} from "./logger";

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

async function commitIfPossible(walletClient: WalletClient) {
  if (await canCommit()) {
    let _lastRewardedBlock = await lastRewardedBlock()
    if (_lastRewardedBlock === 0) {
      _lastRewardedBlock = await firstRegistrationBlock(await getRegistrations())
    }
    const currentEpochStart = getEpochStart(await getBlockNumber(), await epochLength())

    if (_lastRewardedBlock < currentEpochStart && await hasNewerPings(await getBlockTimestamp(currentEpochStart - 1))) {
      const rewards = await epochStats(await getBlockTimestamp(_lastRewardedBlock), await getBlockTimestamp(currentEpochStart - 1))
      await commitRewards(_lastRewardedBlock, currentEpochStart - 1, rewards, walletClient)
      setTimeout(commitIfPossible, 10 * 60 * 1000)
    }
  } else {
    setTimeout(commitIfPossible, 60 * 1000)
  }
}

export async function startWorker(index: number) {
  const basePrivateKey = process.env.PRIVATE_KEY as `0x${string}`
  const privateKey = toHex(fromHex(basePrivateKey, 'bigint') + BigInt(index))
  const walletClient = createWalletClient({
    chain: arbitrumGoerli,
    transport: http(),
    account: privateKeyToAccount(privateKey),
  }).extend(publicActions)
  logger.log(`Worker #${index}`, walletClient.account.address)
  const balance = await walletClient.getBalance({ address: walletClient.account.address })
  logger.log('Balance', balance)
  if (balance === 0n) {
    logger.log('Funding account')
    await createWalletClient({
      transport: http(),
    }).sendTransaction({
      account: privateKeyToAccount(basePrivateKey),
      chain: arbitrumGoerli,
      to: walletClient.account.address,
      value: parseEther('0.05'),
    })
  }
  commitIfPossible(walletClient)
  watchCommits(async (args) => {
    const rewards = await epochStats(await getBlockTimestamp(args.fromBlock), await getBlockTimestamp(args.toBlock))
    await approveRewards(args.fromBlock, args.toBlock, rewards, walletClient)
  })
}
