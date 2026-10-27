FROM node:24.14.0-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
