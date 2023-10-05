import {createPublicClient, createWalletClient, http} from 'viem'
import {arbitrumGoerli, goerli} from 'viem/chains'
import {privateKeyToAccount} from 'viem/accounts'

export const publicClient = createPublicClient({
  chain: arbitrumGoerli,
  transport: http('https://arbitrum-goerli.infura.io/v3/e4b66244e61a4149af62215a6d907226'),
})

export const l1Client = createPublicClient({
  chain: goerli,
  transport: http(),
})

export const walletClient = createWalletClient({
  chain: arbitrumGoerli,
  transport: http(),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as any),
})
