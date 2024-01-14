FROM ghcr.io/foundry-rs/foundry:latest as foundry
FROM node:20-alpine3.18

COPY --from=foundry /usr/ /usr/
COPY --from=foundry /lib/ /lib/

WORKDIR /usr/src/app

COPY packages/contracts/foundry.toml ./contracts/foundry.yaml
COPY packages/contracts/src ./contracts/src
COPY packages/contracts/package.json ./contracts/package.json
WORKDIR /usr/src/app/contracts
RUN forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
RUN yarn build
WORKDIR /usr/src/app/
COPY packages/contracts/deployments ./contracts/deployments
COPY packages/rewards-calculator ./rewards-calculator

WORKDIR /usr/src/app/rewards-calculator

RUN yarn

CMD ["yarn", "start", "1"]
