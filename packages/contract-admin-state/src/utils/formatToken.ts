import { toNumber } from "./toNumber";
import { formatEther } from "viem";

export const formatToken = (amount?: bigint) =>
  amount !== undefined ? `${toNumber(formatEther(amount))} SQD` : "";
