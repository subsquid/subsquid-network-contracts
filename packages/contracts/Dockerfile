FROM node:18-slim

WORKDIR /usr/src/app

COPY package*.json .
COPY scripts ./scripts
COPY deployments ./deployments

RUN npm install -g npm
RUN npm install && npm link

ENV RPC_PROVIDER_URL=https://arbitrum-goerli.public.blastapi.io
ENV NETWORK_NAME=arbitrum-goerli

ENTRYPOINT ["npx", "subsquid-network-register"]
