#!/bin/bash
set -e

echo "=== Starting Arbitrum Fork Setup ==="
source ./docker-scripts/setup_env.sh

echo "Starting Anvil fork of Arbitrum mainnet..."
anvil \
  --fork-url "$FORK_URL" \
  --chain-id "$CHAIN_ID" \
  --host 0.0.0.0 \
  --port "$ANVIL_PORT" \
  --accounts 10 \
  --balance 1000 \
  --gas-limit 30000000 \
  --gas-price 1000000000 \
  --base-fee 1000000000 \
  --block-time 1 &

ANVIL_PID=$!
echo "Anvil started with PID: $ANVIL_PID"

echo "Waiting for Anvil to be ready..."
sleep 5

echo "Testing connection to fork..."
cast block-number --rpc-url "$RPC_URL" || {
  echo "Failed to connect to Anvil fork"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
}

echo "Fork is ready! Current block: $(cast block-number --rpc-url "$RPC_URL")"

echo "=== Verifying Existing Contracts ==="
echo "Checking Router contract..."
ROUTER_TREASURY=$(cast call "$ROUTER_ADDRESS" "rewardTreasury()(address)" --rpc-url "$RPC_URL")
echo "Router points to RewardTreasury: $ROUTER_TREASURY"

echo "Checking Staking contract..."
STAKING_ROUTER=$(cast call "$STAKING_ADDRESS" "router()(address)" --rpc-url "$RPC_URL" 2>/dev/null || echo "No router method")
echo "Staking contract accessible: $STAKING_ROUTER"

echo "=== Deploying New DistributedRewardsDistribution Contract ==="

echo "Deploying new DistributedRewardsDistribution..."
forge script script/DeployDistributedRewards.s.sol:DeployDistributedRewards \
  --private-key "$ADMIN_KEY" \
  --rpc-url "$RPC_URL" \
  --broadcast 

echo "Deployment script execution completed!"
BROADCAST_PATH="./broadcast/DeployDistributedRewards.s.sol/$CHAIN_ID/run-latest.json"
echo "Attempting to read contract address from: $BROADCAST_PATH"
if [ ! -f "$BROADCAST_PATH" ]; then
  echo "ERROR: Broadcast file not found at $BROADCAST_PATH"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
fi

NEW_DISTRIBUTED_REWARDS_ADDRESS=$(jq -r '.transactions[] | select(.contractName == "DistributedRewardsDistribution" and .transactionType == "CREATE") | .contractAddress' "$BROADCAST_PATH" | head -1)
if [ "$NEW_DISTRIBUTED_REWARDS_ADDRESS" = "null" ] || [ -z "$NEW_DISTRIBUTED_REWARDS_ADDRESS" ]; then
  echo "Failed to extract new contract address from broadcast file: $BROADCAST_PATH"
  echo "Contents of broadcast file:"
  cat "$BROADCAST_PATH"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
fi

echo "New DistributedRewardsDistribution deployed at: $NEW_DISTRIBUTED_REWARDS_ADDRESS"

echo "=== Updating Router Contract ==="
MAINNET_ROUTER_ADMIN_ADDRESS="0x5800eEB867D6c490051321239E15C3ac90e801C1" 

echo "Funding impersonated admin account: $MAINNET_ROUTER_ADMIN_ADDRESS"
cast rpc anvil_setBalance "$MAINNET_ROUTER_ADMIN_ADDRESS" "0x3635C9ADC5DEA00000" --rpc-url "$RPC_URL" || { # 1000 ETH
  echo "Failed to set balance for impersonated account"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
}
BALANCE_CHECK=$(cast balance "$MAINNET_ROUTER_ADMIN_ADDRESS" --rpc-url "$RPC_URL")
echo "Balance of $MAINNET_ROUTER_ADMIN_ADDRESS is now: $(cast --from-wei $BALANCE_CHECK) ETH"

echo "Instructing Anvil to impersonate account: $MAINNET_ROUTER_ADMIN_ADDRESS"
cast rpc anvil_impersonateAccount "$MAINNET_ROUTER_ADMIN_ADDRESS" --rpc-url "$RPC_URL" || {
  echo "Failed to impersonate account $MAINNET_ROUTER_ADMIN_ADDRESS"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
}
echo "Anvil is now impersonating $MAINNET_ROUTER_ADMIN_ADDRESS"

echo "Attempting to set reward treasury on Router ($ROUTER_ADDRESS) to $NEW_DISTRIBUTED_REWARDS_ADDRESS..."
echo "Using impersonated admin: $MAINNET_ROUTER_ADMIN_ADDRESS"

cast send "$ROUTER_ADDRESS" \
  "setRewardTreasury(address)" "$NEW_DISTRIBUTED_REWARDS_ADDRESS" \
  --from "$MAINNET_ROUTER_ADMIN_ADDRESS" \
  --unlocked "$MAINNET_ROUTER_ADMIN_ADDRESS" \
  --rpc-url "$RPC_URL" \
  --gas-limit 300000 

NEW_ROUTER_TREASURY=$(cast call "$ROUTER_ADDRESS" "rewardTreasury()(address)" --rpc-url "$RPC_URL")
echo "Router now points to RewardTreasury: $NEW_ROUTER_TREASURY"

if [ "$(echo "$NEW_ROUTER_TREASURY" | tr '[:upper:]' '[:lower:]')" != "$(echo "$NEW_DISTRIBUTED_REWARDS_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "ERROR: Failed to update Router's rewardTreasury!"
  echo "Expected $NEW_DISTRIBUTED_REWARDS_ADDRESS, but got $NEW_ROUTER_TREASURY"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
else
  echo "Router's rewardTreasury successfully updated."
fi

export REWARDS_CONTRACT_ADDRESS="$NEW_DISTRIBUTED_REWARDS_ADDRESS"
export ROUTER_CONTRACT_ADDRESS="$ROUTER_ADDRESS"

echo "Exported REWARDS_CONTRACT_ADDRESS for internal use: $REWARDS_CONTRACT_ADDRESS"
echo "Exported ROUTER_CONTRACT_ADDRESS for internal use: $ROUTER_CONTRACT_ADDRESS"

echo "=== Granting REWARDS_DISTRIBUTOR_ROLE on Staking Contract ==="

STAKING_CONTRACT_ADMIN_ADDRESS="$MAINNET_ROUTER_ADMIN_ADDRESS"

echo "Funding Staking contract admin account: $STAKING_CONTRACT_ADMIN_ADDRESS"
cast rpc anvil_setBalance "$STAKING_CONTRACT_ADMIN_ADDRESS" "0x3635C9ADC5DEA00000" --rpc-url "$RPC_URL" || {
  echo "Failed to set balance for Staking admin account"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
}

echo "Anvil to impersonate Staking contract admin: $STAKING_CONTRACT_ADMIN_ADDRESS"
cast rpc anvil_impersonateAccount "$STAKING_CONTRACT_ADMIN_ADDRESS" --rpc-url "$RPC_URL" || {
  echo "Failed to impersonate Staking admin account $STAKING_CONTRACT_ADMIN_ADDRESS"
  kill $ANVIL_PID 2>/dev/null || true
  exit 1
}
echo "Anvil is now impersonating Staking admin: $STAKING_CONTRACT_ADMIN_ADDRESS"

echo "Getting REWARDS_DISTRIBUTOR_ROLE from Staking contract..."
REWARDS_DISTRIBUTOR_ROLE_ON_STAKING=$(cast call "$STAKING_ADDRESS" "REWARDS_DISTRIBUTOR_ROLE()(bytes32)" --rpc-url "$RPC_URL" 2>/dev/null)
if [ -z "$REWARDS_DISTRIBUTOR_ROLE_ON_STAKING" ] || [ "$REWARDS_DISTRIBUTOR_ROLE_ON_STAKING" = "0x" ]; then
    REWARDS_DISTRIBUTOR_ROLE_ON_STAKING=$(cast keccak "REWARDS_DISTRIBUTOR_ROLE")
    echo "Using computed REWARDS_DISTRIBUTOR_ROLE for Staking: $REWARDS_DISTRIBUTOR_ROLE_ON_STAKING"
else
    echo "Retrieved REWARDS_DISTRIBUTOR_ROLE from Staking contract: $REWARDS_DISTRIBUTOR_ROLE_ON_STAKING"
fi

HAS_ROLE_ON_STAKING_BEFORE=$(cast call "$STAKING_ADDRESS" "hasRole(bytes32,address)(bool)" "$REWARDS_DISTRIBUTOR_ROLE_ON_STAKING" "$NEW_DISTRIBUTED_REWARDS_ADDRESS" --rpc-url "$RPC_URL")
echo "DistributedRewardsDistribution ($NEW_DISTRIBUTED_REWARDS_ADDRESS) has REWARDS_DISTRIBUTOR_ROLE on Staking before grant: $HAS_ROLE_ON_STAKING_BEFORE"

if [ "$HAS_ROLE_ON_STAKING_BEFORE" != "true" ]; then
  echo "Granting REWARDS_DISTRIBUTOR_ROLE ($REWARDS_DISTRIBUTOR_ROLE_ON_STAKING) on Staking contract ($STAKING_ADDRESS) to new DistributedRewardsDistribution contract ($NEW_DISTRIBUTED_REWARDS_ADDRESS)..."
  echo "Using impersonated admin: $STAKING_CONTRACT_ADMIN_ADDRESS"

  cast send "$STAKING_ADDRESS" \
    "grantRole(bytes32,address)" "$REWARDS_DISTRIBUTOR_ROLE_ON_STAKING" "$NEW_DISTRIBUTED_REWARDS_ADDRESS" \
    --from "$STAKING_CONTRACT_ADMIN_ADDRESS" \
    --unlocked "$STAKING_CONTRACT_ADMIN_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --gas-limit 300000

  HAS_ROLE_ON_STAKING_AFTER=$(cast call "$STAKING_ADDRESS" "hasRole(bytes32,address)(bool)" "$REWARDS_DISTRIBUTOR_ROLE_ON_STAKING" "$NEW_DISTRIBUTED_REWARDS_ADDRESS" --rpc-url "$RPC_URL")
  echo "DistributedRewardsDistribution ($NEW_DISTRIBUTED_REWARDS_ADDRESS) has REWARDS_DISTRIBUTOR_ROLE on Staking after grant: $HAS_ROLE_ON_STAKING_AFTER"

  if [ "$HAS_ROLE_ON_STAKING_AFTER" != "true" ]; then
    echo "ERROR: Failed to grant REWARDS_DISTRIBUTOR_ROLE on Staking contract to DistributedRewardsDistribution contract!"
    kill $ANVIL_PID 2>/dev/null || true
    exit 1
  else
    echo "Successfully granted REWARDS_DISTRIBUTOR_ROLE on Staking contract."
  fi
else
  echo "DistributedRewardsDistribution already has REWARDS_DISTRIBUTOR_ROLE on Staking contract."
fi

echo "=== Setting up Additional Distributors ==="

DISTRIBUTOR1_ADDR=$(cast wallet address --private-key "$DISTRIBUTOR1_KEY")
DISTRIBUTOR2_ADDR=$(cast wallet address --private-key "$DISTRIBUTOR2_KEY")
ADMIN_ADDR=$(cast wallet address --private-key "$ADMIN_KEY")

echo "Admin address for roles: $ADMIN_ADDR"
echo "Distributor 1 address: $DISTRIBUTOR1_ADDR"
echo "Distributor 2 address: $DISTRIBUTOR2_ADDR"

DISTRIBUTOR_ROLE=$(cast call "$NEW_DISTRIBUTED_REWARDS_ADDRESS" "REWARDS_DISTRIBUTOR_ROLE()(bytes32)" --rpc-url "$RPC_URL")
echo "Distributor role hash: $DISTRIBUTOR_ROLE"

HAS_ROLE_1=$(cast call "$NEW_DISTRIBUTED_REWARDS_ADDRESS" "hasRole(bytes32,address)(bool)" "$DISTRIBUTOR_ROLE" "$DISTRIBUTOR1_ADDR" --rpc-url "$RPC_URL")
HAS_ROLE_2=$(cast call "$NEW_DISTRIBUTED_REWARDS_ADDRESS" "hasRole(bytes32,address)(bool)" "$DISTRIBUTOR_ROLE" "$DISTRIBUTOR2_ADDR" --rpc-url "$RPC_URL")

echo "Distributor 1 has role: $HAS_ROLE_1"
echo "Distributor 2 has role: $HAS_ROLE_2"

if [ "$HAS_ROLE_1" = "false" ]; then
  echo "Adding Distributor 1..."
  cast send "$NEW_DISTRIBUTED_REWARDS_ADDRESS" "addDistributor(address)" "$DISTRIBUTOR1_ADDR" \
    --private-key "$ADMIN_KEY" \
    --rpc-url "$RPC_URL" \
    --gas-limit 200000
fi

if [ "$HAS_ROLE_2" = "false" ]; then
  echo "Adding Distributor 2..."
  cast send "$NEW_DISTRIBUTED_REWARDS_ADDRESS" "addDistributor(address)" "$DISTRIBUTOR2_ADDR" \
    --private-key "$ADMIN_KEY" \
    --rpc-url "$RPC_URL" \
    --gas-limit 200000
fi

echo "Contract setup completed!"
wait $ANVIL_PID 