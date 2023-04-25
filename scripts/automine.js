// mine new block every 500 ms
const {ethers} = require("hardhat");

async function main() {
  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');;

  while (true) {
    await provider.send("evm_mine");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
