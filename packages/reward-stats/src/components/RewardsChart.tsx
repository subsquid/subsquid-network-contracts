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

interface Reward {
  workerId: number;
  stakerReward: number;
  workerReward: number;
}

interface RewardsChartProps {
  rewards: Reward[];
}

export const RewardsChart = ({ rewards }: RewardsChartProps) => {
  return (
    <ResponsiveContainer>
      <BarChart data={rewards}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="workerId" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey="workerReward" stackId="a" fill="#8884d8" />
        <Bar dataKey="stakerReward" stackId="a" fill="#82ca9d" />
      </BarChart>
    </ResponsiveContainer>
  );
};
