import {createPublicClient, createWalletClient, http} from 'viem'
import {arbitrumGoerli, goerli} from 'viem/chains'
import {privateKeyToAccount} from 'viem/accounts'

export const publicClient = createPublicClient({
  chain: arbitrumGoerli,
  transport: http(),
})

export const l1Client = createPublicClient({
  chain: goerli,
  transport: http(),
})

export const walletClient = createWalletClient({
  chain: arbitrumGoerli,
  transport: http(),
  account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
})

// walletClient.request({
//   method: 'evm_setIntervalMining',
//   params: [3000]
// })
