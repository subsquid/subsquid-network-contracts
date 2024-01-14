FROM node:20 as node
FROM ghcr.io/foundry-rs/foundry:latest

COPY --from=node /lib /lib
COPY --from=node /usr /usr

WORKDIR /usr/src/app

COPY packages/contracts/foundry.toml ./contracts/foundry.yaml
COPY packages/contracts/src ./contracts/src
COPY packages/contracts/package.json ./contracts/package.json
WORKDIR /usr/src/app/contracts
RUN forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
RUN npm run build
WORKDIR /usr/src/app/
COPY packages/contracts/deployments ./contracts/deployments
COPY packages/rewards-calculator ./rewards-calculator

WORKDIR /usr/src/app/rewards-calculator

RUN npm i

CMD ["npm", "run", "start", "1"]
