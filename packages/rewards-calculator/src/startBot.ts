import { RewardBot } from './rewardBot';
import { getVaultAddress } from './fordefi/getAddress';

export async function startBot(index: number) {
  const address = await getVaultAddress();
  const bot = new RewardBot(address, index);
  bot.startBot();
}
