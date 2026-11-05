// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stand-in for the compiled sidecar in the orphan tests (claude-auth.test.ts):
// the real entry (`main`), with the CLI it would have extracted replaced by the
// script named in LIAISON_TEST_FAKE_CLI.

import { main } from "./index"

process.exit(await main(process.env.LIAISON_TEST_FAKE_CLI ?? null))
