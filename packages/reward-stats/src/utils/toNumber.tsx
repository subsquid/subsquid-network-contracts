import { formatEther } from "viem";

export const toNumber = (eth: bigint) => Number(formatEther(eth));
