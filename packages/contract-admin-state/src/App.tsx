import { useMulticall } from "./hooks/useMulticall";
import { useBlockNumber } from "wagmi";
import { mainnet } from "wagmi/chains";
import { formatToken } from "./utils/formatToken";
import { fromBip, toNumber } from "./utils/toNumber";

function Pair({
  label,
  value,
}: {
  label: string;
  value?: { toString(): any };
}) {
  return (
    <p className="">
      <span className="italic">{label}: </span>
      <span className="">{value?.toString()}</span>
    </p>
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode[] | React.ReactNode;
  title: string;
}) {
  return (
    <div className="border-b-2 p-10">
      <h2 className="font-bold">{title}</h2>
      {children}
    </div>
  );
}

export function App() {
  const data = useMulticall();
  const { data: blockNumber } = useBlockNumber({
    chainId: mainnet.id,
    watch: true,
  });

  return (
    <main className="">
      <div className="">
        <div className="">
          <Section title={"Distributor"}>
            <Pair
              label="Last Block Rewarded"
              value={data.distributor.lastBlockRewarded}
            />
            <Pair label="Current Block Number" value={blockNumber} />
            <Pair
              label="Blocks Since Reward"
              value={
                (data.distributor.lastBlockRewarded ?? 0n) - (blockNumber ?? 0n)
              }
            />
            <Pair
              label="Round Robin Length"
              value={data.distributor.roundRobinBlocks + " blocks"}
            />
            <Pair label="Window Size" value={data.distributor.windowSize} />
            <Pair
              label="Required Approves"
              value={data.distributor.requiredApproves}
            />
          </Section>
          <Section title={"Network Controller"}>
            <Pair label="Next Epoch" value={data.networkController.nextEpoch} />
            <Pair
              label="Epoch Length"
              value={data.networkController.epochLength + " blocks"}
            />
            <Pair
              label="Bond Amount"
              value={formatToken(data.networkController.bondAmount)}
            />
            <Pair
              label="Storage Per Worker"
              value={
                toNumber(data.networkController.storagePerWorkerInGb) + " Gb"
              }
            />
            <Pair
              label="Target Capacity"
              value={toNumber(data.networkController.targetCapacityGb) + " Gb"}
            />
            <Pair
              label="Yearly Reward Cap Coefficient"
              value={fromBip(data.networkController.yearlyRewardCapCoefficient)}
            />
          </Section>
          <Section title="Rewards">
            <Pair
              label="TVL"
              value={formatToken(data.rewardCalc.effectiveTVL)}
            />
            <Pair
              label="Current APY"
              value={fromBip(data.rewardCalc.currentApy)}
            />
            <Pair
              label="Projected daily rewards amount"
              value={dailyReward(
                data.rewardCalc.effectiveTVL,
                data.rewardCalc.currentApy,
              )}
            />
            <Pair label="APY Cap" value={fromBip(data.rewardCalc.apyCap)} />
          </Section>
          <Section title="Staking">
            <Pair label="Max Delegations" value={data.staking.maxDelegations} />
          </Section>
        </div>
      </div>
    </main>
  );
}

function dailyReward(tvl?: bigint, apy?: bigint) {
  if (tvl === undefined || !apy) return "";
  return formatToken((tvl * apy) / 10000n / 365n);
}
