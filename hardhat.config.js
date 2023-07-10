require("@nomiclabs/hardhat-waffle");
require('hardhat-deploy');
require('dotenv').config();


module.exports = {
  solidity: "0.8.18",
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
      accounts: [],
      gasPrice: 80000000000, // 80 Gwei
    },
    arbitrumGoerli: {
      url: `https://arbitrum-goerli.public.blastapi.io`,
      chainId: 421613,
      // accounts: [],
      gasPrice: 80000000000, // 80 Gwei
      epochLengthBlocks: 100,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: 'N89QM8KDR8SZ52I7YCSN6Z35QAUFUYBHBV'
        },
      }
    },
  },
  namedAccounts: {
    deployer: 0,
  },
  paths: {
    deploy: "deploy", // The folder where your deployment scripts are located
  },
};
