import { toNumber } from "./toNumber";

export const formatToken = (amount: bigint) => `${toNumber(amount)} SQD`;
