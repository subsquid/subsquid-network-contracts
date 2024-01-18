import { useContractRead } from "wagmi";
import { workerRegistrationContractConfig } from "../config/contracts";

export function useBond() {
  return (
    useContractRead({
      ...workerRegistrationContractConfig,
      functionName: "bondAmount",
    })?.data ?? 0n
  );
}
