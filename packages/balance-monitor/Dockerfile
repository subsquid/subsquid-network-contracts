FROM node:18-alpine

COPY package.json ./
RUN yarn

COPY . .

RUN yarn build

CMD ["node", "dist/index.js"]

