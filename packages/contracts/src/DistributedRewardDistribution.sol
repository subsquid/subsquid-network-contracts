/**
                                             .::.
                                          .=***#*+:
                                        .=*********+.
                                      .=++++*********=.
                                    .=++=++++++++******-
                                  .=++=++++++++++++******-
                                .=++==+++++++++++==+******+:
                              .=+===+++++++++++++===+*******=
                            .=+===+++++++++++++++===-=*******=
                           .=====++++++++++++++++====-=*****#*.
                           :-===++++++++++++++++++====--+*###=
                          :==+++++++++++++++++++++====---=+*-
                        :=++***************++++++++====--:-
                      .-+*########*************++++++===-:
                     .=##%%##################*****++++===-.
                     =#%%%%%%###########%%#######***+++==--
                     +%@@#****************##%%%#####**++==-.
                     -%#==*##**********##*****#%%%####**+==:
                      *-=*%+##*******##%@@#******#%%###**+=-
                      :=+%%#@%******#%=*@@%*********#%##*++-
                      :=*%@@@**####*#@@@@@%********++*###*+.
                      =+**##*#######*#@@@%#####****++++**+-
                +*-  .+**#**#########*****######****+++=+-
               -#**+:-**++**########***###%%%%##**+++++=.
             ::-**+-=*#*=+**#######***#*###%%%##**++++*+=         :=-
            -###****##%==+**######*******#######**+===*#*+-::::-=*##*
            .#%#******==+***##%%%#********######**++==+%%%##**#####%*
              +#%##******###%%%####****+++*#%%%##*********#%%%%%%%%*.
               :%%%%%%%#%%%%###=.+##**********##########%%##%%%###=
                 #%#%%%%%##**=.  :########%%#:-**#%%%%%##*+++*+-:
                  ::+#**#+=-.     =#%%%%#%%#*.  :=*****=:
                                   :+##*##+=       ..
                                     :-.::

*/
// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IRouter.sol";
import "./AccessControlledPausable.sol";

/**
 * @title Distributed Rewards Distribution Contract
 * @dev Contract has a list of whitelisted distributors
 * Each `roundRobinBlocks` blocks, a new subset of distributors are nominated as committers
 * One of them can then commit a distribution
 * Other distributors can approve it
 * After N approvals, the distribution is executed
 */
contract DistributedRewardsDistribution is AccessControlledPausable, IRewardsDistribution {
  using EnumerableSet for EnumerableSet.AddressSet;

  bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");
  bytes32 public constant REWARDS_TREASURY_ROLE = keccak256("REWARDS_TREASURY_ROLE");

  mapping(uint256 workerId => uint256) internal _claimable;
  mapping(uint256 fromBlock => mapping(uint256 toBlock => bytes32)) public commitments;
  mapping(uint256 fromBlock => mapping(uint256 toBlock => uint8)) public approves;
  mapping(bytes32 commitment => mapping(address distributor => bool)) public alreadyApproved;
  uint256 public requiredApproves;
  uint256 public lastBlockRewarded;
  // How often the current committers set is changed
  uint256 public roundRobinBlocks = 256;
  // Number of distributors which can commit a distribution at the same time
  uint256 public windowSize = 1;

  IRouter public immutable router;
  EnumerableSet.AddressSet private distributors;

  /// @dev Emitted on new commitment
  event NewCommitment(address indexed who, uint256 fromBlock, uint256 toBlock, bytes32 commitment);

  /// @dev Emitted when commitment is approved
  event Approved(address indexed who, uint256 fromBlock, uint256 toBlock, bytes32 commitment);

  /// @dev Emitted when commitment is approved
  event Distributed(
    uint256 fromBlock, uint256 toBlock, uint256[] recipients, uint256[] workerRewards, uint256[] stakerRewards
  );

  /// @dev Emitted when new distributor is added
  event DistributorAdded(address indexed distributor);
  /// @dev Emitted when distributor is removed
  event DistributorRemoved(address indexed distributor);
  /// @dev Emitted when required approvals is changed
  event ApprovesRequiredChanged(uint256 newApprovesRequired);
  /// @dev Emitted when window size is changed
  event WindowSizeChanged(uint256 newWindowSize);
  /// @dev Emitted when round robin blocks is changed
  event RoundRobinBlocksChanged(uint256 newRoundRobinBlocks);

  constructor(IRouter _router) {
    requiredApproves = 1;
    router = _router;
  }

  /**
   * @dev Add whitelisted distributor
   * Only admin can call this function
   */
  function addDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(distributors.add(distributor), "Distributor already added");
    _grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorAdded(distributor);
  }

  /**
   * @dev Remove whitelisted distributor
   * Only admin can call this function
   */
  function removeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(distributors.length() > requiredApproves, "Not enough distributors to approve distribution");
    require(distributors.remove(distributor), "Distributor does not exist");
    _revokeRole(REWARDS_DISTRIBUTOR_ROLE, distributor);

    emit DistributorRemoved(distributor);
  }

  /**
   * @dev Get an index of the first distribuor which can currently commit a distribution
   */
  function distributorIndex() internal view returns (uint256) {
    return (block.number / roundRobinBlocks * roundRobinBlocks) % distributors.length();
  }

  function canCommit(address who) public view returns (bool) {
    uint256 firstIndex = distributorIndex();
    uint256 distributorsCount = distributors.length();
    for (uint256 i = 0; i < windowSize; i++) {
      if (distributors.at((firstIndex + i) % distributorsCount) == who) {
        return true;
      }
    }
    return false;
  }

  /**
   * @dev Commit rewards for a worker
   * @param fromBlock block from which the rewards are calculated
   * @param toBlock block to which the rewards are calculated
   * @param recipients array of workerIds. i-th recipient will receive i-th worker and staker rewards accordingly
   * @param workerRewards array of rewards for workers
   * @param _stakerRewards array of rewards for stakers
   * can only be called by current distributor
   * lengths of recipients, workerRewards and _stakerRewards must be equal
   * can recommit to same toBlock, but this drops approve count back to 1
   * @notice If only 1 approval is required, the distribution is executed immediately
   */
  function commit(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external whenNotPaused {
    require(recipients.length == workerRewards.length, "Recipients and worker amounts length mismatch");
    require(recipients.length == _stakerRewards.length, "Recipients and staker amounts length mismatch");
    require(toBlock >= fromBlock, "toBlock before fromBlock");

    require(canCommit(msg.sender), "Not a committer");
    require(toBlock < block.number, "Future block");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(!alreadyApproved[commitment][msg.sender], "Already approved");
    if (commitments[fromBlock][toBlock] == commitment) {
      _approve(commitment, fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
      return;
    }

    commitments[fromBlock][toBlock] = commitment;
    approves[fromBlock][toBlock] = 0;

    emit NewCommitment(msg.sender, fromBlock, toBlock, commitment);
    _approve(commitment, fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
  }

  /**
   * @dev Approve a commitment
   * Same args as for commit
   * After `requiredApproves` approvals, the distribution is executed
   */
  function approve(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) whenNotPaused {
    require(commitments[fromBlock][toBlock] != 0, "Commitment does not exist");
    bytes32 commitment = keccak256(msg.data[4:]);
    require(commitments[fromBlock][toBlock] == commitment, "Commitment mismatch");
    require(!alreadyApproved[commitment][msg.sender], "Already approved");

    _approve(commitment, fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
  }

  function _approve(
    bytes32 commitment,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) internal {
    approves[fromBlock][toBlock]++;
    alreadyApproved[commitment][msg.sender] = true;

    emit Approved(msg.sender, fromBlock, toBlock, commitment);

    if (approves[fromBlock][toBlock] == requiredApproves) {
      distribute(fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
    }
  }

  /// @return true if the commitment can be approved by `who`
  function canApprove(
    address who,
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) external view returns (bool) {
    if (!hasRole(REWARDS_DISTRIBUTOR_ROLE, who)) {
      return false;
    }
    if (commitments[fromBlock][toBlock] == 0) {
      return false;
    }
    bytes32 commitment = keccak256(abi.encode(fromBlock, toBlock, recipients, workerRewards, _stakerRewards));
    if (commitments[fromBlock][toBlock] != commitment) {
      return false;
    }
    if (alreadyApproved[commitment][who]) {
      return false;
    }
    return true;
  }

  /// @dev All distributions must be sequential and not blocks can be missed
  /// E.g. after distribution for blocks [A, B], next one bust be for [B + 1, C]
  function distribute(
    uint256 fromBlock,
    uint256 toBlock,
    uint256[] calldata recipients,
    uint256[] calldata workerRewards,
    uint256[] calldata _stakerRewards
  ) internal {
    require(lastBlockRewarded == 0 || fromBlock == lastBlockRewarded + 1, "Not all blocks covered");
    for (uint256 i = 0; i < recipients.length; i++) {
      _claimable[recipients[i]] += workerRewards[i];
    }
    router.staking().distribute(recipients, _stakerRewards);
    lastBlockRewarded = toBlock;

    emit Distributed(fromBlock, toBlock, recipients, workerRewards, _stakerRewards);
  }

  /// @dev Treasury claims rewards for an address
  /// @notice Can only be called by the treasury
  /// @notice Claimable amount should drop to 0 after function call
  function claim(address who) external onlyRole(REWARDS_TREASURY_ROLE) whenNotPaused returns (uint256 claimedAmount) {
    claimedAmount = router.staking().claim(who);
    uint256[] memory ownedWorkers = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      uint256 claimedFromWorker = _claimable[workerId];
      claimedAmount += claimedFromWorker;
      _claimable[workerId] = 0;
      emit Claimed(who, workerId, claimedFromWorker);
    }

    return claimedAmount;
  }

  /// @return claimable amount for the address
  function claimable(address who) external view returns (uint256) {
    uint256 reward = router.staking().claimable(who);
    uint256[] memory ownedWorkers = router.workerRegistration().getOwnedWorkers(who);
    for (uint256 i = 0; i < ownedWorkers.length; i++) {
      uint256 workerId = ownedWorkers[i];
      reward += _claimable[workerId];
    }
    return reward;
  }

  /// @dev Set required number of approvals
  function setApprovesRequired(uint256 _approvesRequired) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_approvesRequired > 0, "Approves required must be greater than 0");
    require(_approvesRequired <= distributors.length(), "Approves required must be less than distributors count");
    requiredApproves = _approvesRequired;

    emit ApprovesRequiredChanged(_approvesRequired);
  }

  /// @dev Set required number of approvals
  function setWindowSize(uint256 _windowSize) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_windowSize > 0, "Number of simultaneous committers must be positive");
    require(_windowSize <= distributors.length(), "Number of simultaneous committers less than distributors count");
    windowSize = _windowSize;

    emit WindowSizeChanged(_windowSize);
  }

  /// @dev Set round robin length
  function setRoundRobinBlocks(uint256 _roundRobinBlocks) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(_roundRobinBlocks > 0, "Round robin blocks must be positive");
    roundRobinBlocks = _roundRobinBlocks;

    emit RoundRobinBlocksChanged(_roundRobinBlocks);
  }
}
