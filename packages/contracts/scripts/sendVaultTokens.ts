import fs from "fs";
import { ethers } from "ethers";
import SubsquidVesting from "../artifacts/Vesting.sol/SubsquidVesting";
import { fordefiRequest } from "./fordefi/request";
import { sendFordefiTransaction } from "./fordefi/sendTransaction";

const rpc = "https://sepolia-rollup.arbitrum.io/rpc";

async function sendVaultTokens() {
  const data = fs
    .readFileSync("./vestings.csv")
    .toString()
    .split("\n")
    .filter((line) => line)
    .slice(1)
    .map((line) => line.split(",").slice(0, 2) as [string, string]);
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  let i = 0;
  const total = data.length;
  for (const [wallet, vesting] of data) {
    const vestingContract = new ethers.Contract(
      vesting,
      SubsquidVesting.abi,
      provider,
    );
    const balance = await vestingContract.balanceOf(
      "0x24f9C46d86c064a6FA2a568F918fe62fC6917B3c",
    );
    if (balance.gt(0)) {
      console.log(
        `Vesting ${vesting} has ${ethers.utils.formatEther(balance)} SQD, skipping [${++i}/${total}]`,
      );
      continue;
    }
    const amount = await vestingContract.expectedTotalAmount();
    const vestingStart = await vestingContract.start();
    const end = await vestingContract.end();
    const release = await vestingContract.immediateReleaseBIP();
    const beneficiary = await vestingContract.owner();
    if (beneficiary.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(
        `Beneficiary ${beneficiary} is not equal to wallet ${wallet} for vesting ${vesting}`,
      );
    }
    const name = `
Wallet  ${wallet}
Vesting ${vesting}
Amount            : ${ethers.utils.formatEther(amount)} SQD
Immidiate release : ${ethers.utils.formatEther(amount.mul(release).div(10_000))} SQD (${release.toNumber() / 100}%)
Vesting start     : ${new Date(vestingStart.toNumber() * 1000).toUTCString()}
Vesting end       : ${new Date(end.toNumber() * 1000).toUTCString()}`;
    const request = fordefiRequest(vesting, amount.toString(), name);
    await sendFordefiTransaction(request);
    console.log(
      "Sent transaction to fordefi for",
      vesting,
      `[${++i}/${total}]`,
    );
  }
}

void sendVaultTokens();
