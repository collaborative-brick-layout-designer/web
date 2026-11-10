# syntax=docker/dockerfile:1.7

# Node is pinned to a release and its digest, so a rebuild never picks up an
# older or unexpected Node: 26.12.1 carries the 2026-10-21 security fixes.
# .node-version names the same release for CI (setup-node reads it), and the
# build below stops if the two ever differ, so tests run on production's Node.
ARG NODE_IMAGE=node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe

# ---- builder ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV LEFTHOOK=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 git \
    && rm -rf /var/lib/apt/lists/*

# The lockfile too: the install below takes exactly what it lists.
COPY .node-version pnpm-workspace.yaml pnpm-lock.yaml .pnpmfile.cjs package.json tsconfig.base.json ./
RUN test "v$(cat .node-version)" = "$(node --version)" \
    || { echo "Node $(node --version) here, .node-version says $(cat .node-version): change both together" >&2; exit 1; }
# Node 25 stopped bundling corepack (it's no longer preinstalled on the
# node:*-slim images) — install it explicitly before enabling it.
# - Pin to 0.34.7, not @latest: corepack@0.35.0 narrowed its own supported
#   engines range to exclude Node 25 (EBADENGINE), 0.34.x still covers it.
# - --force: npm's global bin already has yarn/yarnpkg placeholder shims on
#   this base image, and a plain install collides with them (EEXIST).
# pnpm at the version package.json's packageManager names, as in CI.
RUN npm install -g --force corepack@0.34.7 && corepack enable \
    && corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
COPY apps/server/package.json apps/server/tsconfig.json apps/server/tsconfig.build.json apps/server/drizzle.config.ts ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./apps/web/
COPY packages/model/package.json packages/model/tsconfig.json ./packages/model/
COPY packages/bbm/package.json packages/bbm/tsconfig.json ./packages/bbm/
COPY packages/ydoc/package.json packages/ydoc/tsconfig.json ./packages/ydoc/
COPY packages/parts-catalog/package.json packages/parts-catalog/tsconfig.json ./packages/parts-catalog/

RUN git init && pnpm install --frozen-lockfile

COPY apps/server/src ./apps/server/src
COPY apps/server/migrations ./apps/server/migrations
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY packages ./packages
# Shared with the desktop repo; the web's tests (type-checked by the build) read it.
COPY compat ./compat

# Any failing step stops the image build (no `|| true`: a failure here used
# to show up only as a confusing error later in the chain).
RUN pnpm --filter @cld/model        build \
 && pnpm --filter @cld/bbm          build \
 && pnpm --filter @cld/ydoc         build \
 && pnpm --filter @cld/parts-catalog build \
 && pnpm --filter @cld/web          build \
 && pnpm --filter @cld/server       build

# Produce a pruned prod-only node_modules with native addons already compiled.
RUN pnpm --filter @cld/server deploy --prod --legacy /app/server-deploy

# ---- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# Refuse to build on a Node older than the security release.
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a<26||(a===26&&(b<12||(b===12&&c<1)))){console.error('Node '+process.version+' is older than 26.12.1');process.exit(1)}"
# Which build this is, for GET /api/version: the release version, or
# nightly-<short sha> (set by the image workflows).
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production
ENV LEFTHOOK=0

# Pick up Debian's security fixes (e.g. tzdata) on top of the base image.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The runtime only runs `node`: drop the npm / corepack the base image ships,
# whose bundled dependencies (undici, ip-address, ...) the image scan flags.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Copy the deploy output: pruned prod node_modules with compiled native addons,
# server dist, migrations, and web dist.
COPY --from=builder /app/server-deploy/node_modules ./node_modules
COPY --from=builder /app/apps/server/dist           ./apps/server/dist
COPY --from=builder /app/apps/server/migrations     ./apps/server/migrations
COPY --from=builder /app/apps/web/dist              ./apps/web/dist
COPY --from=builder /app/packages/model/dist        ./packages/model/dist
COPY --from=builder /app/packages/bbm/dist          ./packages/bbm/dist
COPY --from=builder /app/packages/ydoc/dist         ./packages/ydoc/dist
COPY --from=builder /app/packages/parts-catalog/dist ./packages/parts-catalog/dist
# The demo account's samples (Admin › Settings › Demo account; apps/server/src/demo/reset.ts).
COPY --from=builder /app/packages/bbm/tests/fixtures/tight-corner.bbm \
                    /app/packages/bbm/tests/fixtures/grand-lobby.bld-venue ./packages/bbm/tests/fixtures/
COPY --from=builder /app/packages/bbm/tests/fixtures/oracle/flex-a.bbm ./packages/bbm/tests/fixtures/oracle/

# Run as the base image's unprivileged `node` user (uid 1000, gid 1000), not
# root. The folders it writes to belong to it, so a new named volume starts
# out owned by node too. A volume an older image made is root's: the
# entrypoint says so and how to hand it over (README › Volumes).
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/cbld-entrypoint
RUN mkdir -p /data /parts /backups /app/apps/server/data \
 && chown node:node /data /parts /backups /app/apps/server/data
USER node

EXPOSE 3000
WORKDIR /app/apps/server
# Healthy once the server answers and its database does (GET
# /api/health/ready), on the port the server itself listens on. Node's own
# fetch, as the image has no curl. The start period covers the migrations
# a new version runs before it listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||process.env.PORT||3000)+'/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/cbld-entrypoint"]
CMD ["node", "dist/index.js"]
