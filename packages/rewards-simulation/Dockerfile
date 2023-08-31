FROM node:18-slim

WORKDIR /usr/src/app

COPY packages/contracts/artifacts ./contracts/artifacts
COPY packages/contracts/deployments ./contracts/deployments
COPY packages/rewards-simulation ./rewards-simulation

RUN ls -la

WORKDIR /usr/src/app/rewards-simulation

RUN yarn

CMD ["yarn", "start"]
