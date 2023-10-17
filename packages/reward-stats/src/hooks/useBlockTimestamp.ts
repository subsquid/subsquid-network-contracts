import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { goerli } from "wagmi/chains";

export function useBlocksTimestamp(
  fromBlock: bigint | undefined,
  toBlock: bigint | undefined,
) {
  const publicClient = usePublicClient({
    chainId: goerli.id,
  });
  const [fromTimestamp, setFromTimestamp] = useState(0);
  const [toTimestamp, setToTimestamp] = useState(0);

  useEffect(() => {
    publicClient
      .getBlock({
        blockNumber: fromBlock,
      })
      .then((block) => setFromTimestamp(Number(block.timestamp) * 1000));
    publicClient
      .getBlock({
        blockNumber: toBlock,
      })
      .then((block) => setToTimestamp(Number(block.timestamp) * 1000));
  }, [fromBlock, toBlock]);

  return { fromTimestamp, toTimestamp, timeDiff: toTimestamp - fromTimestamp };
}
