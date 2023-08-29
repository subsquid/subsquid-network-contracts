import {formatEther} from "viem";
import {decode} from "bs58"
export function keysToFixed(object: Object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'number' ? value.toFixed(2) : value]))
}

export function sum(array: number[]) {
  return array.reduce((acc, value) => acc + value, 0)
}

export function bigSum(array: bigint[]) {
  return array.reduce((acc, value) => acc + value, 0n)
}

export function formatSqd(value: bigint) {
  return formatEther(value).replace(/(\.\d{2})\d+/, '$1')
}

export function fromBase58(value: string) {
  return `0x${Buffer.from(decode(value)).toString('hex')}`
}
