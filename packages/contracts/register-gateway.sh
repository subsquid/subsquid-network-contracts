#!/bin/bash

#if ! [[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
#  echo "PRIVATE_KEY is not set or invalid"
#  exit 1
#fi
#if ! [[ "$GATEWAY_ID" =~ ^12D3.*$ ]]; then
#  echo "GATEWAY_ID is not set or invalid"
#  exit 1
#fi
./scripts/toPeerId.mjs

#echo "You will stake ${STAKE_AMOUNT:-100} tSQD for ${STAKE_DURATION:-180} days"
#
#GATEWAY_ID=$(python3 b58.py $GATEWAY_ID) forge script script/RegisterGateway.s.sol --broadcast --json --rpc-url arbitrum-sepolia
