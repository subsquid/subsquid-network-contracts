FROM ghcr.io/foundry-rs/foundry:v1.2.3

WORKDIR /usr/src/app

USER root
RUN apt update && apt -y install bash curl gnupg
RUN curl -sL https://deb.nodesource.com/setup_22.x | bash
RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ rc main" > /etc/apt/sources.list.d/yarn.list
RUN apt update && apt -y install yarn nodejs

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

