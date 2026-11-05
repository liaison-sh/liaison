// SPDX-License-Identifier: FSL-1.1-ALv2
// Regenerates adapter.schema.json from the zod schema (`bun run gen:schema`).
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { toJsonSchema } from "./json-schema"

writeFileSync(
  join(import.meta.dir, "..", "adapter.schema.json"),
  `${JSON.stringify(toJsonSchema(), null, 2)}\n`,
)
