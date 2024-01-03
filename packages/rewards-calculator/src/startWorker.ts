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
import { privateKeyToAccount } from "viem/accounts";
import { logger } from "./logger";
import { RewardWorker } from "./rewardWorker";

async function transferFundsIfNecessary(
  walletClient: WalletClient & PublicActions,
  from: Account,
) {
  const balance = await walletClient.getBalance({
    address: walletClient.account.address,
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
      to: walletClient.account.address,
      value: parseEther("0.05"),
    });
  }
}

export async function startWorker(index: number) {
  const basePrivateKey = process.env.PRIVATE_KEY as `0x${string}`;
  const privateKey = toHex(fromHex(basePrivateKey, "bigint") + BigInt(index));
  const walletClient = createWalletClient({
    chain: arbitrumSepolia,
    transport: http(),
    account: privateKeyToAccount(privateKey),
  }).extend(publicActions);
  logger.log(`Worker #${index}`, walletClient.account.address);
  await transferFundsIfNecessary(
    walletClient,
    privateKeyToAccount(basePrivateKey),
  );
  const worker = new RewardWorker(walletClient);
  worker.startWorker();
}
