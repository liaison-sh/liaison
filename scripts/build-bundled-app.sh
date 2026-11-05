#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Build a bundled (first-party) Liaison plugin app — freeze + sign + emit
# `<name>-<version>.liaisonapp` + detached `.cosign.bundle` under the app's
# dist/ directory.
#
# Bundled apps live at `liaison/bundled-apps/<name>/`. Phase 16 ships Shopify;
# Phase 17 (Invoicing) and Phase 18 (Boxtal) will reuse this same script.
#
# Usage:
#   bash liaison/scripts/build-bundled-app.sh <name> [--skip-sign] [--skip-typecheck]
#
# From the wrapper monorepo root:
#   bash liaison/scripts/build-bundled-app.sh shopify --skip-sign
#
# From inside liaison/:
#   bash scripts/build-bundled-app.sh shopify --skip-sign
#
# Output (relative to liaison/):
#   bundled-apps/<name>/dist/<name>-<version>.liaisonapp
#   bundled-apps/<name>/dist/<name>-<version>.liaisonapp.cosign.bundle  (unless --skip-sign)
#
# Cosign keyless-sign requires user OIDC interaction (browser opens). For CI /
# unit round-trip we pass `--skip-sign` and freeze-only — the install path then
# needs the kernel's install-service to be in `--trust-unsigned` mode (dev-only).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <app-name> [--skip-sign] [--skip-typecheck]" >&2
  echo "example: $0 shopify --skip-sign" >&2
  exit 1
fi

APP_NAME="$1"
shift

# Resolve liaison/ root from this script's path (scripts/ → liaison/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIAISON_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_SOURCE="${LIAISON_ROOT}/bundled-apps/${APP_NAME}"
OUT_DIR="${APP_SOURCE}/dist"

SKIP_SIGN=0
SKIP_TYPECHECK=0
for arg in "$@"; do
  case "$arg" in
    --skip-sign) SKIP_SIGN=1 ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -d "${APP_SOURCE}" ]]; then
  echo "ERROR: ${APP_SOURCE} does not exist" >&2
  exit 1
fi
if [[ ! -f "${LIAISON_ROOT}/scripts/freeze-app.ts" ]]; then
  echo "ERROR: ${LIAISON_ROOT}/scripts/freeze-app.ts not found" >&2
  exit 1
fi

# A build is heavy work: hold one of the machine-wide slots for it
# (scripts/lib/machine-slots.ts). A caller that already holds one (a test run,
# the catalog build) says so with LIAISON_TEST_LOCK_HELD=1.
if [[ "${LIAISON_TEST_LOCK_HELD:-}" != "1" && -f "${LIAISON_ROOT}/scripts/with-test-lock.ts" ]]; then
  exec bun "${LIAISON_ROOT}/scripts/with-test-lock.ts" --slot-only -- bash "${SCRIPT_DIR}/build-bundled-app.sh" "${APP_NAME}" "$@"
fi

echo "[build-bundled-app] APP_NAME = ${APP_NAME}"
echo "[build-bundled-app] APP_SOURCE = ${APP_SOURCE}"
echo "[build-bundled-app] LIAISON_ROOT = ${LIAISON_ROOT}"
echo "[build-bundled-app] OUT_DIR = ${OUT_DIR}"

mkdir -p "${OUT_DIR}"

echo "[build-bundled-app] Step 1/3 — bun install (app source)"
( cd "${APP_SOURCE}" && bun install )

if [[ "${SKIP_TYPECHECK}" -eq 0 ]]; then
  echo "[build-bundled-app] Step 1.5/3 — bun run typecheck"
  ( cd "${APP_SOURCE}" && bun run typecheck )
fi

echo "[build-bundled-app] Step 2/3 — freeze (.liaisonapp tarball)"
# Freeze runs from LIAISON_ROOT so tsconfig + node_modules resolve.
( cd "${LIAISON_ROOT}" && bun --bun ./scripts/freeze-app.ts "${APP_NAME}" \
    --app-dir "${APP_SOURCE}" \
    --out-dir "${OUT_DIR}" )

# Discover the produced tarball.
TARBALL="$(ls -1 "${OUT_DIR}"/"${APP_NAME}"-*.liaisonapp 2>/dev/null | head -1)"
if [[ -z "${TARBALL}" ]]; then
  echo "ERROR: freeze did not produce a tarball under ${OUT_DIR}" >&2
  exit 1
fi
echo "[build-bundled-app] Frozen: ${TARBALL}"

if [[ "${SKIP_SIGN}" -eq 1 ]]; then
  echo "[build-bundled-app] Step 3/3 — sign SKIPPED (--skip-sign)"
  echo "[build-bundled-app] ✓ Done (unsigned): ${TARBALL}"
  exit 0
fi

echo "[build-bundled-app] Step 3/3 — sign (.cosign.bundle sibling)"
( cd "${LIAISON_ROOT}" && bun --bun ./scripts/sign-app.ts "${TARBALL}" )

SIG="${TARBALL}.cosign.bundle"
if [[ ! -f "${SIG}" ]]; then
  echo "ERROR: sign-app did not produce ${SIG}" >&2
  exit 1
fi

echo "[build-bundled-app] ✓ Done"
echo "[build-bundled-app]   tarball:   ${TARBALL}"
echo "[build-bundled-app]   signature: ${SIG}"
