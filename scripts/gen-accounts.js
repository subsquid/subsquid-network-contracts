const { ethers } = require("ethers");

function generatePrivateKeys(numberOfKeys) {
  const privateKeys = [];

  for (let i = 0; i < numberOfKeys; i++) {
    const randomWallet = ethers.Wallet.createRandom();
    privateKeys.push(randomWallet.privateKey);
  }

  return privateKeys;
}

const numberOfKeys = 10;
const privateKeys = generatePrivateKeys(numberOfKeys);

console.log("Generated Private Keys:");
privateKeys.forEach((privateKey, index) => {
  console.log(`WORKER_${index}=${privateKey}`);
});