// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which demo worlds this deployment runs: the worlds a visitor's entry can
// lead to, and the worlds the warm pool keeps workspaces of.
import { DEMO_DEFAULT_WORLD, type DemoWorldId } from "@liaison/shared"

/** The worlds this deployment runs, in `DEMO_WORLDS` order. Never empty. */
export function enabledDemoWorlds(): DemoWorldId[] {
  return [DEMO_DEFAULT_WORLD]
}
