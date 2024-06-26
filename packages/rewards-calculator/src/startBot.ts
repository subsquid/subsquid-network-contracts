import {
  Account,
  createWalletClient,
  fromHex,
  http,
  parseEther,
  PublicActions,
  publicActions,
  toHex,
  WalletClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { logger } from "./logger";
import { RewardBot } from "./rewardBot";
import { getVaultAddress } from "./fordefi/getAddress";

async function transferFundsIfNecessary(
  walletClient: WalletClient & PublicActions,
  from: Account,
) {
  const balance = await walletClient.getBalance({
    address: walletClient.account!.address,
  });
  logger.log("Balance", balance);
  if (balance === 0n) {
    logger.log("Funding account");
    await createWalletClient({
      chain: arbitrumSepolia,
      transport: http(),
    }).sendTransaction({
      account: from,
      chain: arbitrumSepolia,
      to: walletClient.account!.address,
      value: parseEther("0.05"),
    });
  }
}

export async function startBot(index: number) {
  const address = await getVaultAddress();
  const bot = new RewardBot(address, index);
  bot.startBot();
}
