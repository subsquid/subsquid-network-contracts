// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {MerkleProof} from '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

contract MerkleDistributor {
  IERC20 public immutable token;
  bytes32 public immutable merkleRoot;

  event Claimed(uint256 indexed index, address indexed account, uint256 amount);

  // This is a packed array of booleans.
  mapping(uint256 => uint256) private claimedBitMap;

  constructor(IERC20 token_, bytes32 merkleRoot_) {
    token = token_;
    merkleRoot = merkleRoot_;
  }

  function isClaimed(uint256 index) public view returns (bool) {
    uint256 claimedWordIndex = index / 256;
    uint256 claimedBitIndex = index % 256;
    uint256 claimedWord = claimedBitMap[claimedWordIndex];
    uint256 mask = (1 << claimedBitIndex);
    return claimedWord & mask == mask;
  }

  function _setClaimed(uint256 index) private {
    uint256 claimedWordIndex = index / 256;
    uint256 claimedBitIndex = index % 256;
    claimedBitMap[claimedWordIndex] = claimedBitMap[claimedWordIndex] | (1 << claimedBitIndex);
  }

  function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof) external {
    require(!isClaimed(index), 'MerkleDistributor: Drop already claimed.');

    // Verify the merkle proof.
    bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    require(MerkleProof.verifyCalldata(merkleProof, merkleRoot, leaf), 'MerkleDistributor: Invalid proof.');

    // Mark it claimed and send the token.
    _setClaimed(index);
    require(token.transfer(account, amount), 'MerkleDistributor: Transfer failed.');

    emit Claimed(index, account, amount);
  }
}
