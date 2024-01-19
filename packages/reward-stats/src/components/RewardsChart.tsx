// recharts bar chart component
import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Workers } from "../hooks/useWorkers";
import { Stakes } from "../hooks/useStakes";
import { formatToken } from "../utils/formatToken";
import { useBond } from "../hooks/useBond";
import { toNumber } from "../utils/toNumber";

interface Reward {
  workerId: number;
  stakerReward: number;
  workerReward: number;
}

interface RewardsChartProps {
  rewards: Reward[];
  workers?: Workers;
  stakes: Stakes;
  timeDiff: number;
}

export const RewardsChart = ({
  rewards,
  workers,
  stakes,
  timeDiff,
}: RewardsChartProps) => {
  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    payload?: [{ payload: Reward }];
    active?: boolean;
    label?: number;
  }) => {
    const year = 1000 * 60 * 60 * 24 * 365;
    if (active && payload && label) {
      return (
        <div className="bg-white p-3 ">
          <h2 className="font-bold uppercase">
            Worker "{workers?.[label]?.metadata.name}" (#{label})
          </h2>
          <p>{workers?.[label]?.peerId}</p>
          <p className="w-30">{workers?.[label]?.metadata.description}</p>
          <p className="w-30">{workers?.[label]?.metadata.email}</p>
          <p className="text-[#8884d8]">
            Worker reward: {payload[0].payload.workerReward}
            &nbsp;(bond: {formatToken(bond)})
          </p>
          <p className="text-[#82ca9d]">
            Staker reward: {payload[0].payload.stakerReward}
            &nbsp;(staked: {formatToken(stakes[label])})
          </p>
          <p className="text-[#8884d8]">
            Worker APY:{" "}
            {(
              (100 * payload[0].payload.workerReward * year) /
              toNumber(bond) /
              timeDiff
            ).toFixed(2)}
            %
          </p>
          {!!stakes[label] && (
            <p className="text-[#82ca9d]">
              Staker APY:{" "}
              {(
                (100 * payload[0].payload.stakerReward * year) /
                toNumber(stakes[label]) /
                timeDiff
              ).toFixed(2)}
              %
            </p>
          )}
        </div>
      );
    }
  };

  const bond = useBond();

  return (
    <ResponsiveContainer height={600}>
      <BarChart data={rewards}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="workerId" />
        <YAxis />
        <Tooltip content={<CustomTooltip />} />
        <Legend />
        <Bar dataKey="workerReward" stackId="a" fill="#8884d8" />
        <Bar dataKey="stakerReward" stackId="a" fill="#82ca9d" />
      </BarChart>
    </ResponsiveContainer>
  );
};
