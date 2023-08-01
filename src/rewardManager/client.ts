import {createPublicClient, createWalletClient, http} from 'viem'
import {hardhat} from 'viem/chains'
import {privateKeyToAccount} from 'viem/accounts'

export const publicClient = createPublicClient({
  chain: hardhat,
  transport: http(),
})

export const walletClient = createWalletClient({
  chain: hardhat,
  transport: http(),
  account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
})

walletClient.request({
  method: 'evm_setIntervalMining',
  params: [3000]
})
