// SPDX-License-Identifier: FSL-1.1-ALv2
// Standalone mock OIDC server — run with Bun.
// Spawned by Playwright global-setup as a child process.
import { startMockOidc } from "../../../../api/src/tests/e2e/helpers/mock-oidc"

const port = Number(process.argv[2] ?? 4580)
const oidc = await startMockOidc(port)
console.log(`mock-oidc listening on ${oidc.url}`)

// Keep alive until killed
process.on("SIGTERM", () => {
  oidc.stop()
  process.exit(0)
})
