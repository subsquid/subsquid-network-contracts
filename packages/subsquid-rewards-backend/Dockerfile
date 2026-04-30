FROM node:18-alpine

WORKDIR /usr/src/app

# install pnpm
RUN npm install -g pnpm

COPY packages/subsquid-rewards-backend ./subsquid-rewards-backend
WORKDIR /usr/src/app/subsquid-rewards-backend

RUN pnpm install

RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start:prod"] 