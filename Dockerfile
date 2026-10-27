# The RapidMX DNS controller.
#
# Stages: builder (full toolchain: installs, compiles) -> runtime (the published image; the last stage, so a plain
# `docker build .` produces it). The controller has no run-time dependencies, so the runtime gets no node_modules at all.
FROM node:24-trixie-slim AS builder
WORKDIR /app

# Corepack fetches the yarn release named by package.json's packageManager on first use.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first so the dependency layer is reused until they change.
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# Distroless Node.js: node itself and the CA bundle, no shell, no package manager, running as uid 65532 (nonroot). This
# is the only RapidMX pod allowed to create Deployments, Secrets and Jobs, so it carries nothing it does not need.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
LABEL org.opencontainers.image.title="dns-controller" \
      org.opencontainers.image.description="Publishes a RapidMX deployment's DNS records through external-dns." \
      org.opencontainers.image.source="https://github.com/rapidmx/dns-controller" \
      org.opencontainers.image.licenses="MPL-2.0"
WORKDIR /app

# Root-owned and read-only to the process. The controller writes nothing to disk, so the pod runs with a read-only root
# file system. package.json is read at start-up for the controller's version (reported in the API handshake).
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

# 8080: the internal API (from phase C2; only the server may reach it). 8081: /healthz and /readyz.
EXPOSE 8080 8081

USER nonroot

# The distroless image's entrypoint is node itself, so node is PID 1 and SIGTERM reaches the controller's own shutdown,
# which releases its Lease.
CMD ["dist/src/main.js"]
