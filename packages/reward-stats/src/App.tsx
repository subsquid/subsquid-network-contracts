import { useRewards } from "./hooks/useRewards";
import { useState } from "react";
import { RewardLinks } from "./components/RewardLinks";
import { Stats } from "./components/Stats";

export function App() {
  const rewards = useRewards();
  const [selectedReward, setSelectedReward] = useState(0);

  return (
    <main className="grid grid-cols-5">
      <div className="col-span-1 mr-4 border-2">
        <p className="relative p-3 text-center font-bold shadow">
          fromBlock - toBlock
        </p>
        <div className="max-h-[100vh] overflow-y-scroll">
          <RewardLinks
            rewards={rewards}
            onClick={setSelectedReward}
            selected={selectedReward}
          />
        </div>
      </div>
      <div className="col-span-4 max-h-[100vh] overflow-y-scroll pr-4">
        <Stats rewards={rewards} selectedReward={selectedReward} />
      </div>
    </main>
  );
}
