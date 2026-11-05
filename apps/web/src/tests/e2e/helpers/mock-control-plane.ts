// SPDX-License-Identifier: FSL-1.1-ALv2
// Re-export the api-side helper so Playwright fixtures can import it without
// reaching across the apps/web → apps/api boundary directly. The implementation
// lives in apps/api/src/tests/e2e/helpers/mock-control-plane.ts.
export {
  type FakeControlPlaneHandle,
  startFakeControlPlane,
} from "../../../../../api/src/tests/e2e/helpers/mock-control-plane"
