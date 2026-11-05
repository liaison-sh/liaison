// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Optional prop-shape helper for plugin components that prefer prop-style
// injection over module-level imports. Tests can inject a mock host via
// these props without touching globals — useful for component-test isolation.
// Plugin production code typically uses the `app`/`fetch` named imports
// from "@liaison/host" instead.
import type { HostServices } from "./index"

export interface HostProps {
  host: HostServices
}
