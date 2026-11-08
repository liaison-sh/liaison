// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Whether this platform has committed pixel baselines: darwin (made on a Mac)
 * and linux (made on the gate workflow's pinned runner image), as
 * `<name>-<platform>.png` (docs/testing.md, Visual baselines). The scenarios
 * that guard their pixel comparisons with it compare on both; their functional
 * assertions run everywhere. On CI a missing baseline fails, never skips.
 */
export const PIXEL_BASELINES = process.platform === "darwin" || process.platform === "linux"
