// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The BUILD half of the Help tab: writes the docs bundle (scripts/docs/build-app-bundle.ts)
// into `public/help-docs/` before Vite serves or builds, so the dev server, the web build,
// the desktop shell (which embeds `dist`) and the phone build (`dist-native`) all carry the
// docs of their own version. Nothing in the browser imports this file: `vite.config.ts` does.
//
// It runs the writer through bun, because the docs renderer reads frontmatter with Bun.YAML
// and Vite may run under Node. A writer that fails stops the build: a Help tab with no docs
// behind it is a broken screen, not a quiet one.

import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

export function helpDocsBundle(webRoot: string): { name: string; buildStart(): void } {
  let written = false
  return {
    name: "liaison-help-docs",
    buildStart() {
      if (written) return
      written = true
      execFileSync(
        "bun",
        [
          resolve(webRoot, "../../scripts/docs/build-app-bundle.ts"),
          "--out",
          resolve(webRoot, "public/help-docs"),
        ],
        { stdio: "inherit" },
      )
    },
  }
}
