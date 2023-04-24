require("@nomiclabs/hardhat-waffle");
require('hardhat-deploy');
require('dotenv').config();


module.exports = {
  solidity: "0.8.0",
  networks: {
    hardhat: {
      chainId: 31337,
      epochLengthBlocks: 1,
      blockTime: 1,
    //   mining: {
    //     auto: false,
    //     interval: 500
    //   }
    },
    sepolia: {
      chainId: 11155111,
      // sepolia block time is ~ 12 secs. 
      epochLengthBlocks: 10,
      url: `https://eth-sepolia.public.blastapi.io`,
      accounts: [
        process.env.DEPLOYER,
        process.env.WORKER_0,
        process.env.WORKER_1,
        process.env.WORKER_2,
        process.env.WORKER_3,
        process.env.WORKER_4,
        process.env.WORKER_5,
        process.env.WORKER_6,
        process.env.WORKER_7,
        process.env.WORKER_8,
        process.env.WORKER_9
      ],
      gasPrice: 80000000000, // 80 Gwei
    },
    arbitrumGoerli: {
      url: `https://arbitrum-goerli.public.blastapi.io`,
      chainId: 421613,
      accounts: [
        process.env.DEPLOYER,
        process.env.WORKER_0,
        process.env.WORKER_1,
        process.env.WORKER_2,
        process.env.WORKER_3,
        process.env.WORKER_4,
        process.env.WORKER_5,
        process.env.WORKER_6,
        process.env.WORKER_7,
        process.env.WORKER_8,
        process.env.WORKER_9
      ],
      gasPrice: 80000000000, // 80 Gwei
    },
  },
  namedAccounts: {
    deployer: 0,
  },
  paths: {
    deploy: "deploy", // The folder where your deployment scripts are located
  },
};
