import { getL2Network } from "@arbitrum/sdk";
import { ethers } from "ethers";
import SQDL1 from "../artifacts/SQD.sol/SQD";
import SQDL2 from "../artifacts/SQD.sol/SQDArbitrum";
import { AdminErc20Bridger } from "@arbitrum/sdk/dist/lib/assetBridger/erc20Bridger";

const l1provider = ethers.providers.getDefaultProvider("sepolia");
const l2provider = ethers.providers.getDefaultProvider(
  "https://sepolia-rollup.arbitrum.io/rpc",
);
const privateKey = process.env.PRIVATE_KEY;
const l2Network = await getL2Network(l2provider);

async function deployL1() {
  const signer = new ethers.Wallet(privateKey, l1provider);
  const l1TokenFactory = new ethers.ContractFactory(
    SQDL1.abi,
    SQDL1.bytecode,
    signer,
  );
  const amounts = [100];
  const addresses = [signer.address];
  const l1Token = await l1TokenFactory.deploy(
    addresses,
    amounts,
    l2Network.tokenBridge.l1CustomGateway,
    l2Network.tokenBridge.l1GatewayRouter,
  );
  return l1Token.deployed();
}

async function deployL2(l1TokenAddress: string) {
  const signer = new ethers.Wallet(privateKey, l2provider);
  const l2TokenFactory = new ethers.ContractFactory(
    SQDL2.abi,
    SQDL2.bytecode,
    signer,
  );
  const l2Token = await l2TokenFactory.deploy(
    l2Network.tokenBridge.l2CustomGateway,
    l1TokenAddress,
  );
  return l2Token.deployed();
}

async function registerBridge(l1TokenAddress: string, l2TokenAddress: string) {
  const adminTokenBridger = new AdminErc20Bridger(l2Network);
  const registerTokenTx = await adminTokenBridger.registerCustomToken(
    l1TokenAddress,
    l2TokenAddress,
    new ethers.Wallet(privateKey, l1provider),
    l2provider,
  );
  const registerTokenRec = await registerTokenTx.wait();
  console.log(
    `Registering token txn confirmed on L1! 🙌 L1 receipt is: ${registerTokenRec.transactionHash}`,
  );

  const l1ToL2Msgs = await registerTokenRec.getL1ToL2Messages(l2provider);
  const setTokenTx = await l1ToL2Msgs[0].waitForStatus();
  const setGateways = await l1ToL2Msgs[1].waitForStatus();
  console.log(
    "Your custom token is now registered on our custom gateway 🥳  Go ahead and make the deposit!",
  );
}

const main = async () => {
  const l1Token = await deployL1();
  console.log("L1 Token deployed to:", l1Token.address);
  const l2Token = await deployL2(l1Token.address);
  console.log("L2 Token deployed to:", l2Token.address);

  await registerBridge(l1Token.address, l2Token.address);
};

main();
