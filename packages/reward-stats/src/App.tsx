import { useRewards } from "./hooks/useRewards";
import { useEffect, useState } from "react";
import { RewardLink } from "./components/RewardLink";
import { Stats } from "./components/Stats";
import { createClient } from "@clickhouse/client-web";

const clickhouse = createClient({
  host: "https://clickhouse.subsquid.io/",
  username: "sqd_read",
  password: import.meta.env.VITE_CLICKHOUSE_PASSWORD,
});

const query = `select workerId, sum(responseBytes), sum(readChunks) from testnet.queries group by workerId`;

export function App() {
  const rewards = useRewards();
  const [selectedReward, setSelectedReward] = useState(0);

  useEffect(() => {
    (async () => {
      const resultSet = await clickhouse.query({
        query,
        format: "JSONEachRow",
        clickhouse_settings: {
          add_http_cors_header: 0,
        },
      });
      const reader = resultSet.stream().getReader();
      while (true) {
        const { done, value: rows } = await reader.read();
        if (done) {
          break;
        }
        rows.forEach((row) => {
          console.log(row.json());
        });
      }
    })();
  }, []);

  return (
    <main className="grid grid-cols-5">
      <div className="col-span-1 border-2">
        <p className="relative p-3 text-center font-bold shadow">
          fromBlock - toBlock
        </p>
        <div className="max-h-[100vh] overflow-y-scroll">
          <RewardLink rewards={rewards} onClick={setSelectedReward} />
        </div>
      </div>
      <div className="col-span-4 max-h-[100vh] overflow-y-scroll ">
        <Stats reward={rewards[selectedReward]} />
      </div>
    </main>
  );
}
