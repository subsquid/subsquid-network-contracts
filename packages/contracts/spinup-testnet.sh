#!/bin/bash

ls -la .
ls -la lib
ls -la lib/openzeppelin-contracts
ls -la lib/openzeppelin-contracts/contracts
ls -la lib/openzeppelin-contracts/contracts/token
ls -la lib/openzeppelin-contracts/contracts/token/ERC20


forge build
forge script script/Deploy.s.sol --broadcast --json --rpc-url $RPC_URL
forge script script/PreparePlayground.s.sol --tc PreparePlayground --broadcast --json --rpc-url $RPC_URL
echo "Deployed contract addresses"
jq '[.transactions[] | select(.transactionType == "CREATE")] | map({contractName, contractAddress})' ./broadcast/Deploy.s.sol/31337/run-latest.json
