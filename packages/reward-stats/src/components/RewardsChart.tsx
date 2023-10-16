// recharts bar chart component
import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Workers } from "../hooks/useWorkers";

interface Reward {
  workerId: number;
  stakerReward: number;
  workerReward: number;
}

interface RewardsChartProps {
  rewards: Reward[];
  workers?: Workers;
}

export const RewardsChart = ({ rewards, workers }: RewardsChartProps) => {
  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    payload?: [{ payload: Reward }];
    active?: boolean;
    label?: number;
  }) => {
    if (active && payload && label) {
      return (
        <div className="bg-white p-3 ">
          <p>Worker: {workers?.[label]?.peerId ?? label}</p>
          <p>Creator: {workers?.[label]?.creator}</p>
          <p className="text-[#8884d8]">
            Worker reward: {payload[0].payload.workerReward}
          </p>
          <p className="text-[#82ca9d]">
            Staker reward: {payload[0].payload.stakerReward}
          </p>
        </div>
      );
    }
  };

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
