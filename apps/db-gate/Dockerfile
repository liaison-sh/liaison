# SPDX-License-Identifier: FSL-1.1-ALv2
#
# liaison/db-gate — standalone read-only query sidecar. One container, one
# minted token, one reviewable catalog file. Postgres never exposed.
#
# The base image is pinned by digest (tag beside it), like apps/api/Dockerfile:
# a tag can be repointed, a digest cannot.

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /app
COPY package.json bun.lock ./
# Every workspace's manifest, though only two ship here: bun refuses a frozen
# install when a workspace the lockfile lists is not on disk ("listed in
# bun.lock but not on disk"). scripts/dockerfile-workspaces.test.ts keeps this
# list equal to the root's workspaces.
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/db-gate/package.json apps/db-gate/
COPY apps/desktop/package.json apps/desktop/
COPY apps/desktop/sidecar/package.json apps/desktop/sidecar/
COPY apps/mobile/package.json apps/mobile/
COPY packages/api-connector-core/package.json packages/api-connector-core/
COPY packages/app-sdk/package.json packages/app-sdk/
COPY packages/app-ui/package.json packages/app-ui/
COPY packages/control-plane-contract/package.json packages/control-plane-contract/
COPY packages/db-core/package.json packages/db-core/
COPY packages/host-sdk/package.json packages/host-sdk/
COPY packages/mailbox-crypto/package.json packages/mailbox-crypto/
COPY packages/shared/package.json packages/shared/
COPY packages/test-helpers/package.json packages/test-helpers/
# The reviewed lockfile or nothing: a frozen install that fails stops the build
# instead of falling back to a fresh resolution.
RUN bun install --frozen-lockfile --filter '@liaison/db-gate' --filter '@liaison/db-core'
COPY packages/db-core /app/packages/db-core
COPY apps/db-gate /app/apps/db-gate

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
# groupadd/useradd (passwd, in every Debian image): the slim image has no
# addgroup/adduser.
RUN groupadd --system dbgate && useradd --system --gid dbgate --no-create-home dbgate
WORKDIR /app
COPY --from=build /app /app
USER dbgate
WORKDIR /app/apps/db-gate
EXPOSE 8478
ENV DB_GATE_PORT=8478
ENTRYPOINT ["bun", "run", "src/index.ts"]
