# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Solidity smart contract system for the Subsquid (SQD) Portal staking platform. It implements a multi-portal staking system where providers can stake SQD tokens, earn fees from multiple payment tokens, and manage their allocations across different portals.

## Build & Test Commands

### Foundry (Solidity Contracts)

```bash
# Build contracts
forge build

# Run all tests
forge test

# Run tests with verbosity (shows console logs)
forge test -vv

# Run specific test contract
forge test --match-contract PortalFactoryTest

# Run specific test function
forge test --match-test testStake

# Run tests with gas reporting
forge test --gas-report

# Format Solidity code
forge fmt

# Deploy to local network (anvil)
forge script script/Deploy.s.sol:DeployPortalSystem --rpc-url http://localhost:8545 --broadcast

# Start local node
anvil
```

### Frontend (Next.js)

The `frontend/` directory contains a Next.js application:

```bash
cd frontend
npm install
npm run dev        # Start development server
npm run build      # Build for production
npm run start      # Start production server
```

## Architecture Overview

### Core Contracts

**PortalImplementation** (`src/PortalImplementation.sol`)
- Main upgradeable portal contract (UUPS pattern)
- Manages provider stakes, exit requests, and fee distribution
- Supports multiple payment tokens for fee distribution
- State machine: COLLECTING → ACTIVE → (FAILED/SUNSET)
- Uses OpenZeppelin's upgradeable contracts (Initializable, UUPSUpgradeable, AccessControlUpgradeable, PausableUpgradeable)

**PortalFactory** (`src/PortalFactory.sol`)
- Creates portal instances using minimal proxy pattern (Clones)
- Manages portal upgrades (individual or batch)
- Handles stake reallocation between portals via `moveStake()`
- Tracks all portals and operator-portal mappings

**GatewayRegistry** (`src/GatewayRegistry.sol`)
- Central registry for all portals
- Manages SQD token transfers and provider allocations
- Handles unlock requests with epoch-based withdrawal limits (1% per epoch)
- Calculates computation units (CUs) based on stake and mana
- Tracks provider allocations across multiple portals

**FeeRouterModule** (`src/FeeRouterModule.sol`)
- Configurable fee split between providers, worker pool, and burn
- Default: 50% providers, 50% worker pool, 0% burn
- Admin can adjust splits (must sum to 100%)

### Key Design Patterns

**Upgradeable Proxies**
- Portals use UUPS (Universal Upgradeable Proxy Standard)
- Storage layout defined in `PortalStorage.sol` with upgrade gap
- Factory can upgrade individual portals or all portals in batches

**Multi-Token Fee Distribution**
- Portals support multiple ERC20 payment tokens (not just SQD)
- Payment tokens initialized during portal creation via `initializePaymentTokens()`
- Fee tracking per token using cumulative-per-share model
- Providers earn proportional fees based on active stake (excluding exit amounts)

**Exit Queue System**
- Providers request exit via `requestExit()` which calculates unlock epoch based on percentage of total stake
- Exit formula: `requiredEpochs = 1 + (amount * 100 / totalStaked)`
- Amounts in exit queue stop earning rewards immediately
- Withdrawal happens through GatewayRegistry at 1% per epoch
- FAILED portals allow immediate withdrawal via `withdrawFromFailed()`

**Stake Reallocation**
- Providers can move stake between portals via `PortalFactory.moveStake()`
- Atomically updates both portals and GatewayRegistry allocations
- Maintains portal active status based on minimum stake threshold

**Role-Based Access**
- DEFAULT_ADMIN_ROLE: Portal operator (set during initialization)
- OPERATOR_ROLE: Can distribute fees, activate portal
- FACTORY_ROLE: Can perform stake moves and batch upgrades
- PAUSER_ROLE: Can pause/unpause factory and registry

### Storage Architecture

Portal storage is defined in `src/storage/PortalStorage.sol`:
- `PortalInfo`: Operator, capacity, total staked, deadlines, state
- Provider mappings: stakes, exit requests, fee checkpoints
- Multi-token tracking: `allowedPaymentTokens`, `_cumulativeFeesPerShare`, `_providerCheckpoint`
- `__gap[49]`: Reserved storage slots for future upgrades

### Interfaces

All contracts implement clean interfaces in `src/interfaces/`:
- `IPortal.sol`: Portal lifecycle and staking functions
- `IPortalFactory.sol`: Factory creation and upgrade functions
- `IGatewayRegistry.sol`: Registry and allocation management
- `IFeeRouter.sol`: Fee calculation and configuration
- `INetworkController.sol`: Network parameters (epochs, thresholds)

## Testing Notes

Tests use Foundry's test framework with the following patterns:
- `setUp()`: Deploy contracts and configure test environment
- `makeAddr()`: Create labeled test addresses
- `vm.prank()` / `vm.startPrank()`: Simulate different callers
- `vm.expectRevert()`: Test error conditions
- Mock contracts in `test/mocks/` for external dependencies

Tests are located in `test/`:
- `PortalFactory.t.sol`: Portal creation and management
- `GatewayRegistry.t.sol`: Registry and allocation logic
- `FeeRouterModule.t.sol`: Fee distribution calculations
- `PortalPool.t.sol`: Portal lifecycle and staking

## Important Conventions

**Error Handling**
- Custom errors defined in `src/libs/PortalErrors.sol`
- Use `revert ErrorName()` instead of `require()` with strings for gas efficiency

**Safety Patterns**
- Checks-Effects-Interactions pattern in `distributeFees()`
- SafeERC20 for all token transfers
- Access control modifiers (`onlyOperator`, `onlyRole`)
- State checks before operations (`inState`, `whenPortalNotPaused`)

**Upgrade Safety**
- Never remove or reorder storage variables in PortalStorage
- Add new storage variables at the end, reducing `__gap` size accordingly
- Test upgrades with existing proxy state

**Computation Units (CU) Formula**
```solidity
CU = (totalStaked * epochLength * mana * boostFactor) / (10000 * 1e18 * 1000)
```
where `boostFactor = 30000`

## Configuration

Deploy script (`script/Deploy.s.sol`) accepts environment variables:
- `PRIVATE_KEY`: Deployer private key (optional for local testing)
- `WORKER_EPOCH_LENGTH`: Default 7200 blocks
- `MIN_STAKE_THRESHOLD`: Default 100,000 SQD
- `MANA`: Default 1000
- `WORKER_REWARD_POOL`: Address for worker rewards
