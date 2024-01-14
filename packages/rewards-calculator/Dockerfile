FROM node:18-slim

WORKDIR /usr/src/app

COPY packages/contracts/artifacts ./contracts/artifacts
COPY packages/contracts/deployments ./contracts/deployments
COPY packages/rewards-calculator ./rewards-calculator

RUN ls -la

WORKDIR /usr/src/app/rewards-calculator

RUN yarn

CMD ["yarn", "start", "1"]
