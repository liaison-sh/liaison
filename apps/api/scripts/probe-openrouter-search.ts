// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIVE PROBE of the OpenRouter `web_search` backend (S13, OPEN-1): sends the
// exact request the backend sends and reports, per citation, how much page
// content came back, and what the call cost. Paid (under a cent).
//
//   set -a; source .env.test; set +a
//   bun run apps/api/scripts/probe-openrouter-search.ts "<query>" [--save <file.json>]
//
// `--save` writes the raw response, which is how the unit test's fixture
// (src/modules/agent/tools/__fixtures__/openrouter-web-search.json) was recorded.
import { writeFileSync } from "node:fs"
import { openRouterFetch } from "~/modules/agent/providers/openrouter"
import {
  buildOpenRouterWebSearchRequest,
  mapOpenRouterCitations,
} from "~/modules/agent/tools/web-search-openrouter"

const args = process.argv.slice(2)
const saveAt = args.indexOf("--save")
const savePath = saveAt >= 0 ? args[saveAt + 1] : undefined
const query = args.filter((_, i) => i !== saveAt && i !== saveAt + 1)[0] ?? "latest news today"
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set")
  process.exit(2)
}

const started = Date.now()
const res = await openRouterFetch("/chat/completions", {
  apiKey,
  body: buildOpenRouterWebSearchRequest(query, 5),
})
const body = (await res.json()) as { usage?: { cost?: number } }
const ms = Date.now() - started
if (savePath) writeFileSync(savePath, `${JSON.stringify(body, null, 2)}\n`)
if (!res.ok) {
  console.error(`HTTP ${res.status}`, JSON.stringify(body))
  process.exit(1)
}
const hits = mapOpenRouterCitations(body, 5)
console.log(`query: ${query}`)
console.log(`latency: ${ms} ms, cost: ${body.usage?.cost ?? "unreported"} USD`)
for (const h of hits) console.log(`  ${h.content.length} chars  ${h.url}`)
const long = hits.filter((h) => h.content.length >= 200).length
console.log(`${hits.length} citations, ${long} with content >= 200 chars`)
process.exit(hits.length >= 3 && long >= 3 ? 0 : 1)
