import { createPublicClient, http } from 'viem'
import {hardhat} from 'viem/chains'

export const publicClient = createPublicClient({
  chain: hardhat,
  transport: http()
})

publicClient.request({
  method: 'evm_setIntervalMining',
  params: [3000]
})
