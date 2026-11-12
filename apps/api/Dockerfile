# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# SPDX-License-Identifier: FSL-1.1-ALv2

# Single multi-stage image: API server + bundled web assets.
# Built from the monorepo root: `docker build -f apps/api/Dockerfile .`
#
# The BuildKit frontend (syntax line) and every base image are pinned by digest,
# with the tag beside it for the reader: a tag can be repointed by whoever
# controls it, and the frontend and the base image both run code in every build.
# To bump, resolve the new tag's index digest (`docker buildx imagetools inspect
# <image>:<tag>`) and replace tag and digest together.

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
WORKDIR /app

# System ffmpeg, and FFMPEG_BIN so `ffmpeg-static` resolves to it at RUNTIME instead of to the
# binary its postinstall downloads. That postinstall fetches ~70 MB from a GitHub release on every
# cold build, which makes a third-party CDN a hard dependency of shipping: on 2026-09-14 GitHub
# returned 504 for that asset for over half an hour and NO prod image could be built, with a
# shipping fix already committed and waiting. The apt package is in the image either way, so a
# repeat outage costs a slower install, not a blocked deploy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_BIN=/usr/bin/ffmpeg

# Install dependencies (cache layer). Bun reads `workspaces: ["apps/*",
# "packages/*", "tools/*"]` from the root package.json; every workspace
# manifest referenced by the root lockfile must be present at install time or
# the resolver errors out. Copy each workspace's package.json individually so
# the deps layer stays cache-friendly (no whole-tree COPY).
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/db-gate/package.json apps/db-gate/
# The desktop shell and its sidecar are workspace members (`apps/*` plus the
# explicit `apps/desktop/sidecar`), so `bun install --frozen-lockfile` refuses
# to run without their manifests even though neither ships in this image.
COPY apps/desktop/package.json apps/desktop/
COPY apps/desktop/sidecar/package.json apps/desktop/sidecar/
# Same for the Capacitor shell: it ships nothing into this image either, and
# without its manifest the frozen install refuses the whole build.
COPY apps/mobile/package.json apps/mobile/
COPY packages/api-connector-core/package.json packages/api-connector-core/
COPY packages/app-loader/package.json packages/app-loader/
COPY packages/app-sdk/package.json packages/app-sdk/
COPY packages/app-ui/package.json packages/app-ui/
COPY packages/control-plane-contract/package.json packages/control-plane-contract/
COPY packages/db-core/package.json packages/db-core/
COPY packages/host-sdk/package.json packages/host-sdk/
COPY packages/mailbox-crypto/package.json packages/mailbox-crypto/
COPY packages/shared/package.json packages/shared/
COPY packages/test-helpers/package.json packages/test-helpers/
# The fallback runs ONLY when the normal install fails, which in practice means a package
# postinstall could not reach its CDN (see the ffmpeg note above). Skipping scripts is a
# degradation, not the happy path: every binary those scripts would fetch must already have an
# in-image equivalent, which today is ffmpeg via FFMPEG_BIN.
RUN bun install --frozen-lockfile \
  || (echo "install scripts failed (CDN outage?) -- retrying with --ignore-scripts" \
      && bun install --frozen-lockfile --ignore-scripts)

# Build the web bundle
FROM deps AS web-build
COPY . .
RUN cd apps/web && bun run build
# First-party app catalog: one `.liaisonapp` per bundled-apps/<name>/ + a
# catalog.json index under /app/app-catalog, baked into the runtime image so the
# Apps UI / `liaison config apply` can install a bundled app with one click.
# A bundled app whose source matches a signed release takes that signed artifact
# from downloads.liaison.sh (or from an offline mirror: put it in the build
# context and pass --build-arg LIAISON_APP_ARTIFACTS_DIR=/app/<mirror-dir>); any
# other app is built here, unsigned. Once the index is in, an unreachable host
# never fails the build. The index is added right before this step so that a
# new signed release busts this layer (and only this one). The freeze is a pure
# esbuild bundle of local TS resolving the workspace SDK from the deps tree. (An ARG is visible to RUN as an environment
# variable.)
#
# The signed first-party apps index: `ADD` of a URL checks the remote file on every build
# (BuildKit and the legacy builder alike), so the catalog layer is rebuilt exactly when the
# index changes, even at the same source commit. An EMPTY value skips it: the empty
# placeholder from the build context is added instead, no network for the index, and every
# bundled app is built here, unsigned (offline builders). Point it at a mirror's index.json
# to take the artifacts from there.
ARG LIAISON_APP_INDEX_URL=https://downloads.liaison.sh/apps/index.json
ADD ${LIAISON_APP_INDEX_URL:-apps/api/app-index-none.json} /tmp/app-index/index.json
ARG LIAISON_APP_ARTIFACTS_DIR=
RUN if [ -n "$LIAISON_APP_ARTIFACTS_DIR" ]; then set --; \
    elif [ -n "$LIAISON_APP_INDEX_URL" ]; then \
      set -- --index-file /tmp/app-index/index.json --index-url "$LIAISON_APP_INDEX_URL"; \
    else set -- --no-artifacts; fi \
  && bun run scripts/build-app-catalog.ts --out-dir /app/app-catalog "$@"

# cosign, which verifies a signed runtime app install (.liaisonapp + .cosign.bundle,
# modules/apps/verify-package.ts). Signatures are required by default, so an image
# without it cannot install any signed app. Pinned release binary, checked against the
# release's sha256; fetched with bun (the base image has no curl) in its own stage.
FROM base AS cosign
ARG TARGETARCH
ARG COSIGN_VERSION=v3.0.6
RUN set -eu; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
      amd64|x86_64) arch=amd64; sum=c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74 ;; \
      arm64|aarch64) arch=arm64; sum=bedac92e8c3729864e13d4a17048007cfafa79d5deca993a43a90ffe018ef2b8 ;; \
      *) echo "no cosign build for $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${arch}"; \
    COSIGN_URL="$url" bun -e 'const r = await fetch(process.env.COSIGN_URL); if (!r.ok) throw new Error(`cosign download: ${r.status}`); await Bun.write("/usr/local/bin/cosign", r)'; \
    echo "$sum  /usr/local/bin/cosign" | sha256sum -c -; \
    chmod 755 /usr/local/bin/cosign

# Final image: API + bundled web served from apps/api/public
FROM base AS runtime
ARG LIAISON_VERSION=dev
ENV LIAISON_VERSION=$LIAISON_VERSION
ENV NODE_ENV=production
# [staging patch] The base Dockerfile copied only packages/shared, so the API's
# other workspace deps (@liaison/app-sdk, @liaison/host, ...) were absent at
# runtime -> "Cannot find module '@liaison/app-sdk'". Bring the WHOLE installed
# tree from deps (root + per-workspace node_modules + the @liaison/* symlinks),
# then overlay full source over the manifest-only stubs. (Upstream: copy all
# workspace packages the API imports, not just shared.)
COPY --from=deps /app /app
COPY apps/api /app/apps/api
COPY packages /app/packages
COPY scripts /app/scripts
COPY --from=web-build /app/apps/web/dist /app/apps/api/public
# First-party app catalog (frozen `.liaisonapp` tarballs + catalog.json), read by
# modules/apps/catalog.ts from /app/app-catalog at runtime.
COPY --from=web-build /app/app-catalog /app/app-catalog

# Release manifest (Task 47a). The release pipeline runs
# `bun run scripts/build-release-manifest.ts <tag>` BEFORE `docker build`,
# producing `.liaison-release.json` at the repo root. We COPY it into the image
# when present; otherwise emit a minimal `dev` manifest so the image is always
# self-describing even for local builds.
COPY .liaison-release.json* /app/
RUN if [ ! -f /app/.liaison-release.json ]; then \
      printf '{"version":"%s","builtAt":"unknown"}\n' "$LIAISON_VERSION" > /app/.liaison-release.json ; \
    fi

# Put the `liaison` CLI shim on PATH so `docker compose exec app liaison ...` works.
# Linked as root (before USER bun); the shim itself stays owned and executable as
# copied, and resolves the CLI relative to its own location, so any cwd works.
RUN ln -s /app/apps/api/bin/liaison /usr/local/bin/liaison

COPY --from=cosign /usr/local/bin/cosign /usr/local/bin/cosign
# cosign keeps the Sigstore trust root (TUF) under $HOME by default, which is read-only in
# the shipped compose (read_only: true, only /tmp is writable): without this every
# verification fails with "trusted root is required". Needs outbound HTTPS to Sigstore.
ENV TUF_ROOT=/tmp/sigstore-tuf

EXPOSE 3000
USER bun

# Apply migrations from the apps/api workspace (drizzle reads ./src/db/migrations
# relative to cwd), then launch the API.
#
# Two distinct database roles, by design:
#   * MIGRATION_DATABASE_URL — a privileged (superuser / owner) connection. Only
#     this step uses it: 0000_initial.sql creates the schema, tables, roles, and
#     RLS policies, which the runtime role has no rights to do.
#   * DATABASE_URL — the runtime app role (liaison_app): non-superuser, non-owner,
#     NOBYPASSRLS, so request traffic is subject to row-level security.
# The compose file sets both explicitly. The entrypoint's fallback keeps single-role
# dev setups working (where DATABASE_URL is itself privileged); production must
# NOT rely on it — DATABASE_URL there is the unprivileged app role and cannot
# run DDL.
# The API runs QuickJS WASM in process and must start with JSC's optimizing
# WASM tier off (QUICKJS_HOST_JSC_ENV in apps/api/src/modules/apps/sandbox/pool.ts).
ENV BUN_JSC_useOMGJIT=0
# apps/api/scripts/entrypoint.sh: `serve` (default) migrates under the
# database lease (skipped with LIAISON_MIGRATE_ON_START=false), re-unpacks the
# enabled first-party catalog apps (fail-soft), then `exec`s the server with
# MIGRATION_DATABASE_URL removed from its environment, so SIGTERM reaches the
# app and a foothold in it cannot read the privileged URL. `migrate` runs the
# setup steps once and exits (the step a rolling deploy runs before it starts
# new processes). Any other command runs as given.
ENTRYPOINT ["sh", "/app/apps/api/scripts/entrypoint.sh"]
CMD ["serve"]
