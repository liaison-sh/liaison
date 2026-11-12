// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The executor parity suite (executor-parity.suite.ts) on the Workers
// executor, against the local loader stand-in (__fixtures__/fake-loader.ts).
import { executorParitySuite } from "./executor-parity.suite"

executorParitySuite("workers")
