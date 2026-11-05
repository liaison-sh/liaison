// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Playwright fixture for the sub-agent dispatch UI scenarios (S3 live status,
// S4 gated MCP approval rerouting, S8 visual baselines).
//
// The default `fixtures/test.ts` fixes `serverEnv` at the moment `createWorkerEnv`
// runs — too early for `AGENT_STREAM_STUB` and `CHAOS_DEBUG=1`, which the API
// reads during `app.ts` module load. This fixture composes via `createProfiledE2ETest`
// so those vars land before the API process spawns. Each scenario file imports
// the resulting `test` and passes its own stub path via the `subAgentStubPath`
// argument.

import path from "node:path"
import { createProfiledE2ETest } from "./profiled-test"

const REPO_ROOT = path.resolve(__dirname, "../../../../..")

const DEFAULT_STUB = path.join(REPO_ROOT, "apps/api/src/tests/e2e/helpers/sub-agent-smoke-stub.ts")

export function createSubAgentTest(subAgentStubPath: string = DEFAULT_STUB) {
  return createProfiledE2ETest({
    // Worker offset 30 — keeps deterministic-port range disjoint from the
    // default fixture (offset 10) and phase14 (offset 20 in the repo).
    workerIdOffset: 30,
    portCount: 2,
    before: async () => ({
      env: {
        // No CHAOS_DEBUG: `agent.spawn` is a kernel-universal capability
        // (KERNEL_CAPABILITIES), present in every org. The chaos-debug app
        // this fixture once booted for it is not part of this repository, and
        // CHAOS_DEBUG=1 without its injector module refuses to boot ("Worker 32
        // server exited with code 1 before listening", every sub-agent scenario).
        // Cross-process stub. The bundle replaces `streamText`; provider keys
        // below pass the availability pre-check before the stub kicks in.
        LIAISON_ANTHROPIC_API_KEY: "sk-stub-not-used",
        GOOGLE_API_KEY: "stub-not-used",
        OPENAI_API_KEY: "stub-not-used",
        MISTRAL_API_KEY: "stub-not-used",
        AGENT_STREAM_STUB: subAgentStubPath,
        // The placeholder keys above would otherwise send the server's own
        // side calls (chat title generation, message-search embeddings) to the
        // real providers, which reject them. Offline, titles use the heuristic
        // and search runs keyword-only: no outbound model call at all.
        LIAISON_OFFLINE_SIDE_CALLS: "1",
        // As the api sub-agent smoke: the e2e server's 8-connection pool plans
        // ONE kernel agent worker slot (planKernelSlots scales the classes to
        // the privileged pool), and a sub-run then queues behind other agent
        // work and stays "queued". Production's compose default (15) keeps the
        // default plan.
        DB_PRIVILEGED_POOL_MAX: "15",
        // Belt-and-suspenders bump: worker-env already sets this to 999999,
        // but be explicit so any future env defaulting can't strangle the
        // suite's busier scenarios (S3 + S8 fire several /api/* requests
        // back-to-back: login, seed, SSE, WS handshake, polls).
        RATE_LIMIT_DEFAULT: "999999",
      },
      teardowns: [],
    }),
  })
}
