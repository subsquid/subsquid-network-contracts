import { ethers } from "ethers";
import SubsquidVesting from "../artifacts/Vesting.sol/SubsquidVesting";
import WorkerRegistration from "../artifacts/WorkerRegistration.sol/WorkerRegistration";

const EXAMPLE_PEER_ID = "0x1231231231231231";

const privateKey = process.env.PRIVATE_KEY;
const address =
  process.env.ADDRESS || "0x9f4B51E0AAE7404D7036653866517081f88859E7";
const rpc = process.env.RPC || "https://sepolia-rollup.arbitrum.io/rpc";
if (!privateKey) {
  throw new Error("Missing PRIVATE_KEY environment variable");
}
const wallet = new ethers.Wallet(
  privateKey,
  new ethers.providers.JsonRpcProvider(rpc),
);
const vestedContract = new ethers.Contract(
  address,
  SubsquidVesting.abi,
  wallet,
);
const workerRegistrationContract = new ethers.Contract(
  "0x1b188e52CEC575A359B1FAa4649a0739BD4442a4",
  WorkerRegistration.abi,
  wallet,
);
async function vestedRegister() {
  const calldata = workerRegistrationContract.interface.encodeFunctionData(
    "register(bytes,string)",
    [EXAMPLE_PEER_ID, '{ "name": "Created from vested wallet" }'],
  );
  const bond = await workerRegistrationContract.bondAmount();
  const tx = await vestedContract["execute(address,bytes,uint256)"](
    workerRegistrationContract.address,
    calldata,
    bond,
  );
  console.log(tx);
  await tx.wait();
}

vestedRegister();
