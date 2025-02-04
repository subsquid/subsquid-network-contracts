FROM ghcr.io/foundry-rs/foundry:stable

WORKDIR /usr/src/app

RUN apk add nodejs-current yarn npm bash
COPY packages/contracts/foundry.toml ./contracts/foundry.toml
COPY packages/contracts/deployments ./contracts/deployments
COPY packages/contracts/src ./contracts/src
COPY packages/contracts/package.json ./contracts/package.json

WORKDIR /usr/src/app/contracts
RUN forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts OpenZeppelin/openzeppelin-contracts-upgradeable PaulRBerg/prb-math@release-v4 --no-git
RUN yarn build
WORKDIR /usr/src/app
COPY packages/rewards-calculator ./rewards-calculator
WORKDIR /usr/src/app/rewards-calculator
RUN yarn

CMD ["yarn start 1"]

