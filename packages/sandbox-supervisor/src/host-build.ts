// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host Worker (host-worker.ts + @liaison/app-loader) as one ES module for
// workerd, built once per supervisor start. `cloudflare:workers` is workerd's
// own and stays external.

import { join } from "node:path"

let built: Promise<string> | null = null

export function hostWorkerSource(): Promise<string> {
  built ??= (async () => {
    const out = await Bun.build({
      entrypoints: [join(import.meta.dir, "host-worker.ts")],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    })
    const file = out.outputs[0]
    if (!out.success || !file) {
      built = null
      throw new Error(`host Worker build failed: ${out.logs.map((l) => l.message).join("; ")}`)
    }
    return file.text()
  })()
  return built
}
