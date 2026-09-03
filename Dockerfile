FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS production-install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM install AS build
COPY . .
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=production-install /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER bun
EXPOSE 3000

CMD ["bun", "run", "start:prod"]
