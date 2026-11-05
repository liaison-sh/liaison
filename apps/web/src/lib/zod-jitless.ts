// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Zod without eval, for the browser. Zod 4 compiles an object schema's parser with `new Function`
// and, to know whether it may, probes `new Function("")` once. The page's CSP has no
// 'unsafe-eval', so the probe failed, was caught, and still raised a `script-src` violation report
// on every load. `jitless` turns the compiled parsers off and skips the probe.
//
// The setting is read when a schema is BUILT, so it must be in place before any module builds one.
// An import at the top of the entry is not enough: chunks the entry imports run before its body.
// So the web build resolves every `import ... from "zod"` to THIS module (vite.config.ts alias):
// whoever imports zod gets it already configured.
import { config } from "zod/v4"

config({ jitless: true })

export * from "zod/v4"
export { default } from "zod/v4"
