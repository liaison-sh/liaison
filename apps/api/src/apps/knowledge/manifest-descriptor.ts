// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFile } from "node:fs/promises"
import knowledgeManifestJson from "./app.manifest.json"

// Skill bodies live as on-disk markdown next to the descriptor; `app.manifest.json`
// is JSON-pure (no function bodies). The TS descriptor injects them with lazy
// loaders so the runtime resolves them once at app-register time — see
// `apps/api/src/modules/apps/runtime.ts` around the `desc.skills` block.
const KNOWLEDGE_CREATE_BODY_PATH = new URL("./skills/knowledge-create.md", import.meta.url).pathname

export const knowledgeAppManifest = {
  ...knowledgeManifestJson,
  skills: {
    // Keep the JSON-declared skills (e.g. the `knowledge-overview` guide) and
    // add the TS-only lazy-body skill. Because this `skills` object contains a
    // function body, `freshManifest` carries the WHOLE key from the descriptor
    // — so the JSON guide must be re-merged here or it would be dropped.
    ...(knowledgeManifestJson as { skills?: Record<string, unknown> }).skills,
    "knowledge-create": {
      description:
        "Create a Knowledge document or source_link from any external place the user names",
      requiredScopes: ["knowledge:documents:create", "knowledge:collections:manage"],
      body: async () => readFile(KNOWLEDGE_CREATE_BODY_PATH, "utf8"),
    },
  },
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}
