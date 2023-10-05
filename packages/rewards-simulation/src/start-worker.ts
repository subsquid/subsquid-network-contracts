import {
  alreadyCommitted,
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
  const epochLen = await epochLength()
  try {
    if (await canCommit(walletClient)) {
      const MAX_COMMIT_LENGTH = epochLen * 1_000
      logger.log('Can commit', walletClient.account.address)
      let _lastRewardedBlock = await lastRewardedBlock()
      if (_lastRewardedBlock === 0) {
        _lastRewardedBlock = await firstRegistrationBlock(await getRegistrations())
      }
      let currentEpochStart = getEpochStart(await getBlockNumber(), epochLen)
      if (currentEpochStart - _lastRewardedBlock > MAX_COMMIT_LENGTH) {
        currentEpochStart = _lastRewardedBlock + MAX_COMMIT_LENGTH
      }
      const fromBlock = _lastRewardedBlock + 1
      const toBlock = currentEpochStart - 1
      if (fromBlock < toBlock && await hasNewerPings(await getBlockTimestamp(toBlock + 1))) {
        const rewards = await epochStats(await getBlockTimestamp(fromBlock), await getBlockTimestamp(toBlock))
        await commitRewards(fromBlock, toBlock, rewards, walletClient)
      }
    }
  } catch (e) {logger.log(e)}
  setTimeout(() => commitIfPossible(walletClient), 60 * 1000)
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
  const balance = await walletClient.getBalance({address: walletClient.account.address})
  logger.log('Balance', balance)
  if (balance === 0n) {
    logger.log('Funding account')
    await createWalletClient({
      chain: arbitrumGoerli,
      transport: http(),
    }).sendTransaction({
      account: privateKeyToAccount(basePrivateKey),
      chain: arbitrumGoerli,
      to: walletClient.account.address,
      value: parseEther('0.05'),
    })
  }
  commitIfPossible(walletClient)
  watchCommits(async ({fromBlock, toBlock}) => {
    if (!fromBlock) return
    const rewards = await epochStats(await getBlockTimestamp(fromBlock), await getBlockTimestamp(toBlock))
    await approveRewards(fromBlock, toBlock, rewards, walletClient)
  })
}
