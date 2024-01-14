#!/usr/bin/env zx

import {peerIdFromKeys} from '@libp2p/peer-id'
import fs from "fs";

$.verbose = false;

if (!process.env.PRIVATE_KEY.match(/^0x[0-9a-fA-F]{64}$/)) {
  console.log("Please set PRIVATE_KEY env var");
  process.exit(1);
}
if (process.env.CLIENT_KEY_PATH) {
  const peerId = (await peerIdFromKeys(fs.readFileSync(process.env.CLIENT_KEY_PATH))).toString();
  console.log(`PeerID from ${process.env.CLIENT_KEY_PATH}: ${peerId}`);
  process.env.GATEWAY_ID = peerId;
}
if (!process.env.GATEWAY_ID.match(/^(Qm|12D3).*$/)) {
  console.log("Please set GATEWAY_ID env var");
  process.exit(1);
}
console.log(`You will stake ${process.env.STAKE_AMOUNT ?? 100} tSQD for ${process.env.STAKE_DURATION ?? 180} days"`);
process.env.GATEWAY_ID = '0x' + (await $`python3 b58.py $GATEWAY_ID`)
process.env.GATEWAY_ID = process.env.GATEWAY_ID.trim()
await $`forge script script/RegisterGateway.s.sol --broadcast --json --rpc-url arbitrum-sepolia`
