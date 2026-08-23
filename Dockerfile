# ---- deps ----
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# --ignore-scripts is the mitigation for the 2026 install-hook attacks (§2).
# It is also set in .npmrc; passed here so the flag is visible in the build log.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=prod
RUN addgroup -S app && adduser -S app -G app && apk add --no-cache tini
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
# dist/migrate.js is in this image on purpose: the mandated deploy order is
# migrations first, then code, and before it existed the runtime image had no way
# to apply one — scripts/ is excluded from the build and tsx is pruned. Run it as
# a job with the same image and `command: ["node", "dist/migrate.js"]`.
# tini as PID 1 so SIGTERM reaches Node and graceful shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
# Same image for API and workers; the orchestrator overrides CMD for workers.
CMD ["node", "dist/main.js"]
# No HEALTHCHECK: the orchestrator owns liveness/readiness (§14).
