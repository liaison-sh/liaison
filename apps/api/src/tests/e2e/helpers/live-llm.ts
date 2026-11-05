// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIVE-MODEL GATE for the api e2e scenarios.
//
// A scenario that drives a REAL model provider spends money on every run, so it
// is not part of the default suite. It runs only when the run opts in with
// LIAISON_E2E_LIVE_LLM=1 (scripts/test-run.ts then hands the e2e suites the
// machine's real provider keys; without it they get the same fixed placeholders
// as every other suite, see apps/api/src/tests/test-env-defaults.ts). The
// Playwright journeys have the same switch, PLAYWRIGHT_LIVE_LLM.
//
// Scenarios that only need the agent LOOP script the model instead (the
// scripted provider, LIAISON_MODEL_PROVIDER=scripted, or AGENT_STREAM_STUB)
// and stay in the default suite.
//
// Gate on this flag, never on "is a key set": the default run carries a
// placeholder key, so a key-presence check would let a live scenario through
// to the provider, where it fails with an opaque provider error.

import { describe, it } from "bun:test"

/** True when the run opted into scenarios that call a real model provider. */
export const LIVE_LLM = process.env.LIAISON_E2E_LIVE_LLM === "1"

/** `describe` for a block whose every case calls a real model provider. */
export const describeLive = describe.skipIf(!LIVE_LLM)

/** `it` for a case that calls a real model provider. */
export const itLive = it.skipIf(!LIVE_LLM)
