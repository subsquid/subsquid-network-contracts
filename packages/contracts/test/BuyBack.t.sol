// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../src/BuyBack.sol";
import "./BaseTest.sol";

contract BuyBackTest is BaseTest {
  BuyBack otc;
  SQD token;

  function setUp() public {
    (SQD _token,) = deployAll();

    token = _token;
    otc = new BuyBack(token, address(this));

    token.transfer(address(1), 1000);

    token.approve(address(otc), type(uint256).max);
    hoax(address(1));
    token.approve(address(otc), type(uint256).max);
  }

  function test_Deposit() public {
    hoax(address(1));
    otc.deposit(100);
    assertEq(token.balanceOf(address(otc)), 100);
  }

  function test_Withdraw() public {
    otc.deposit(100);
    otc.withdraw(address(2), 10);
    assertEq(token.balanceOf(address(2)), 10);
  }

  function test_RevertsIf_WithdrawNotByAdmin() public {
    hoax(address(1));
    expectNotAdminRevert();
    otc.withdraw(address(2), 10);
  }
}
