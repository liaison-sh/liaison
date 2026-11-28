#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# The one web build behind a signed shell: apps/web in both modes (dist/ and
# dist-native/). apps/api/Dockerfile runs it, and so does every shell builder
# (.github/workflows/shell-build.yml and the second, independent builder). A
# signed statement names a build id (apps/web/scripts/stamp-build-id.ts), and a
# server serves the signed shell only when its own build has that id, so every
# one of them must turn the same source into the same bytes. That holds only
# when they run this script, on the same bun:
#
# - bun is the version in .bun-version, the one the image's base pins. Bun
#   bundles the app frame runtime itself (scripts/build-app-frame.ts), and its
#   output changes between releases. A different bun is refused.
# - vite runs on bun (`bun --bun vite`, apps/web/package.json), never on a
#   node that happens to be installed: vite inlines some of its own functions'
#   source text into the bundle, and that text differs between the two runtimes.
# - the build sees no environment but PATH, HOME and TMPDIR, so nothing a
#   builder has set (NODE_ENV, VITE_*, LIAISON_*, CI) can reach the bundle.
#
# Usage: scripts/shell-signing/build-web.sh   (from anywhere; dependencies installed)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
want="$(tr -d '[:space:]' < "$root/.bun-version")"
have="$(bun --version)"
if [ "$have" != "$want" ]; then
  echo "build-web: bun $have, the shell build is pinned to bun $want (.bun-version)" >&2
  exit 1
fi

clean=(env -i "PATH=$PATH" "HOME=${HOME:-/root}")
if [ -n "${TMPDIR:-}" ]; then clean+=("TMPDIR=$TMPDIR"); fi

cd "$root/apps/web"
"${clean[@]}" bun run build
"${clean[@]}" bun run build:native
