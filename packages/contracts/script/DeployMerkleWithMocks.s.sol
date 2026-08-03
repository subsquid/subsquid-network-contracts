// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {DistributedRewardsDistribution} from "../src/DistributedRewardsDistribution.sol";
import {IRouter} from "../src/interfaces/IRouter.sol";
import {IStaking} from "../src/interfaces/IStaking.sol";
import {IWorkerRegistration} from "../src/interfaces/IWorkerRegistration.sol";
import {INetworkController} from "../src/interfaces/INetworkController.sol";
import {IRewardCalculation} from "../src/interfaces/IRewardCalculation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployMerkleWithMocks is Script {
  function run() external {
    uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
    vm.startBroadcast(deployerPrivateKey);

    MockRouter router = new MockRouter();
    MockToken token = new MockToken();
    MockRewardTreasury treasury = new MockRewardTreasury(token);

    router.setRewardTreasury(address(treasury));

    // Deploy MerkleRewardsDistribution (DistributedRewardsDistribution) with router
    DistributedRewardsDistribution merkle = new DistributedRewardsDistribution(IRouter(address(router)));

    // Set up test workers for the deployer and the proper permissions
    MockWorkerRegistration workerReg = MockWorkerRegistration(address(router.workerRegistration()));
    for (uint256 i = 1; i <= 3; i++) {
      workerReg.mockAddWorker(msg.sender, i);
    }

    merkle.grantRole(merkle.REWARDS_DISTRIBUTOR_ROLE(), msg.sender);
    merkle.addDistributor(msg.sender);

    merkle.grantRole(merkle.REWARDS_TREASURY_ROLE(), address(treasury));
    treasury.setWhitelistedDistributor(address(merkle), true);

    MockStaking staking = MockStaking(address(router.staking()));
    staking.grantRole(staking.REWARDS_DISTRIBUTOR_ROLE(), address(merkle));

    vm.stopBroadcast();

    console.log("Router deployed at:", address(router));
    console.log("MerkleRewardsDistribution deployed at:", address(merkle));
  }
}

// Simple ERC20 token mock for testing
contract MockToken is IERC20 {
  mapping(address => uint256) private _balances;
  mapping(address => mapping(address => uint256)) private _allowances;
  uint256 private _totalSupply = 1000000 * 10 ** 18;

  constructor() {
    _balances[msg.sender] = _totalSupply;
  }

  function totalSupply() external view override returns (uint256) {
    return _totalSupply;
  }

  function balanceOf(address account) external view override returns (uint256) {
    return _balances[account];
  }

  function transfer(address to, uint256 amount) external override returns (bool) {
    _balances[msg.sender] -= amount;
    _balances[to] += amount;
    return true;
  }

  function allowance(address owner, address spender) external view override returns (uint256) {
    return _allowances[owner][spender];
  }

  function approve(address spender, uint256 amount) external override returns (bool) {
    _allowances[msg.sender][spender] = amount;
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
    _allowances[from][msg.sender] -= amount;
    _balances[from] -= amount;
    _balances[to] += amount;
    return true;
  }

  // Convenience function for testing
  function mint(address to, uint256 amount) external {
    _balances[to] += amount;
    _totalSupply += amount;
  }
}

contract MockRouter is IRouter {
  IWorkerRegistration public override workerRegistration;
  IStaking public override staking;
  address public override rewardTreasury;
  INetworkController public override networkController;
  IRewardCalculation public override rewardCalculation;

  constructor() {
    workerRegistration = IWorkerRegistration(address(new MockWorkerRegistration()));
    staking = IStaking(address(new MockStaking()));
    networkController = INetworkController(address(new MockNetworkController()));
    rewardCalculation = IRewardCalculation(address(0)); // not needed but lfg
  }

  function setRewardTreasury(address _treasury) external {
    rewardTreasury = _treasury;
  }
}

contract MockWorkerRegistration is IWorkerRegistration {
  mapping(address => uint256[]) private ownedWorkers;
  mapping(uint256 => Worker) private workers;

  struct Worker {
    address creator;
    string peerId;
    uint256 bond;
    uint256 registeredAt;
    uint256 deregisteredAt;
    string metadata;
  }

  function getOwnedWorkers(address owner) external view returns (uint256[] memory) {
    return ownedWorkers[owner];
  }

  function mockAddWorker(address owner, uint256 workerId) external {
    ownedWorkers[owner].push(workerId);
    workers[workerId] =
      Worker({creator: owner, peerId: "", bond: 0, registeredAt: block.timestamp, deregisteredAt: 0, metadata: ""});
  }

  // Required interface implementations
  function isWorkerActive(uint256 workerId) external view returns (bool) {
    return workers[workerId].deregisteredAt == 0;
  }

  function getWorker(uint256 workerId) external view returns (Worker memory) {
    return workers[workerId];
  }

  function register(bytes calldata peerId, string calldata metadata) external {}
  function register(bytes calldata peerId) external {}
  function updateMetadata(bytes calldata peerId, string calldata metadata) external {}
  function deregister(bytes calldata peerId) external {}
  function withdraw(bytes calldata peerId) external {}
  function returnExcessiveBond(bytes calldata peerId) external {}

  function getMetadata(bytes calldata peerId) external view returns (string memory) {
    return "";
  }

  function getActiveWorkerCount() external view returns (uint256) {
    return 0;
  }

  function getActiveWorkerIds() external view returns (uint256[] memory) {
    return new uint256[](0);
  }

  function nextWorkerId() external view returns (uint256) {
    return 0;
  }
}

contract MockStaking is IStaking {
  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

  mapping(address => uint256) public claimableAmount;
  mapping(address => uint256) public claimedAmount;
  mapping(address => bool) public roles;

  function distribute(uint256[] calldata workerIds, uint256[] calldata amounts) external {
    // Mock implementation that would handle staker rewards distribution
  }

  function claim(address who) external returns (uint256) {
    uint256 amount = claimableAmount[who];
    claimableAmount[who] = 0;
    claimedAmount[who] += amount;
    return amount;
  }

  function claimable(address who) external view returns (uint256) {
    return claimableAmount[who];
  }

  function mockSetClaimable(address staker, uint256 amount) external {
    claimableAmount[staker] = amount;
  }

  function grantRole(bytes32 role, address account) external {
    roles[account] = true;
  }

  function revokeRole(bytes32 role, address account) external {
    roles[account] = false;
  }

  // Other required interface implementations
  function delegated(uint256 worker) external view returns (uint256) {
    return 0;
  }

  function deposit(uint256 worker, uint256 amount) external {}
  function withdraw(uint256 worker, uint256 amount) external {}

  function delegates(address staker) external view returns (uint256[] memory) {
    return new uint256[](0);
  }

  function totalStakedPerWorker(uint256[] calldata workers) external view returns (uint256[] memory) {
    uint256[] memory result = new uint256[](workers.length);
    return result;
  }

  function getDeposit(address staker, uint256 worker)
    external
    view
    returns (uint256 depositAmount, uint256 withdrawAllowed)
  {
    return (0, 0);
  }
}

contract MockNetworkController is INetworkController {
  uint128 public epochLength = 100;
  uint128 public firstEpochBlock = 1;
  uint256 public bondAmount = 1000;

  function nextEpoch() external view returns (uint128) {
    return uint128(block.number / epochLength) + 1;
  }

  function epochNumber() external view returns (uint128) {
    return uint128(block.number / epochLength);
  }

  function lockPeriod() external view returns (uint128) {
    return epochLength;
  }

  function isAllowedVestedTarget(address target) external view returns (bool) {
    return false;
  }

  function workerEpochLength() external view returns (uint128) {
    return epochLength;
  }

  function stakingDeadlock() external view returns (uint256) {
    return 0;
  }

  function targetCapacityGb() external view returns (uint256) {
    return 0;
  }

  function yearlyRewardCapCoefficient() external view returns (uint256) {
    return 0;
  }

  function storagePerWorkerInGb() external view returns (uint128) {
    return 0;
  }
}

contract MockRewardTreasury {
  IERC20 public token;
  mapping(address => bool) public whitelistedDistributors;

  constructor(IERC20 _token) {
    token = _token;
  }

  function setWhitelistedDistributor(address distributor, bool whitelisted) external {
    whitelistedDistributors[distributor] = whitelisted;
  }
}
