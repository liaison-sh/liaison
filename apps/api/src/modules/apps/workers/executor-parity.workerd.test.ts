// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The executor parity suite (executor-parity.suite.ts) on workerd: the
// instance's sandbox service (@liaison/sandbox-supervisor, real workerd
// processes running the shared app loader) as the fallback target, so every
// run is labelled `workerd`. Re-run on every bump of the pinned workerd.
import { executorParitySuite } from "./executor-parity.suite"

executorParitySuite("workerd")
