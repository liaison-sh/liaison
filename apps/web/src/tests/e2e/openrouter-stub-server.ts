// SPDX-License-Identifier: FSL-1.1-ALv2
// Standalone OpenRouter stub for the Playwright run (run with Bun), spawned by
// global-setup as a child process. It serves the trimmed test catalogue on
// GET /models, a live key on GET /key, and answers every chat completion with
// one call of the tool offered (the AI models page's test call asks for
// `ping`), streamed or not as the request asks. The API servers reach it
// through OPENROUTER_BASE_URL (packages/test-helpers/src/worker-env.ts).
import {
  STUB_OPENROUTER_CATALOGUE,
  startOpenAICompatibleStub,
} from "../../../../api/src/tests/openai-compatible-stub"

const stub = startOpenAICompatibleStub({ catalogue: STUB_OPENROUTER_CATALOGUE })
console.log(`openrouter-stub listening on ${stub.url}/api/v1`)

process.on("SIGTERM", () => {
  stub.stop()
  process.exit(0)
})
