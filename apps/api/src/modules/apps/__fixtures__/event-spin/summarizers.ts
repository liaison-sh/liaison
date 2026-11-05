// SPDX-License-Identifier: FSL-1.1-ALv2
// Sibling summarizers file required by the manifest registration convention
// (gated tool summarizers load host-side from `<bundle dir>/summarizers.ts`).
// The event-spin fixture reuses the kernel test app's manifest, so its gated
// tools resolve the same summarizer exports.
export * from "../../../../../test-support/apps/test/summarizers"
