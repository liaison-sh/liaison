// SPDX-License-Identifier: FSL-1.1-ALv2
// This script is run via `bun` from the project root with cwd set to project root
// Resolve the mock-oidc helper relative to this file
import { dirname, resolve } from "node:path"

const thisDir = dirname(new URL(import.meta.url).pathname)
const mockOidcPath = resolve(thisDir, "../../../../../apps/api/src/tests/e2e/helpers/mock-oidc.ts")

const { startMockOidc } = await import(mockOidcPath)
const _oidc = await startMockOidc(4580)
console.log("mock-oidc-ready")
// Keep process alive until killed
await new Promise(() => {})
