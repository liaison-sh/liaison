// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which model objects our middlewares (step token cap, answer after tools,
// text tool calls) can wrap. AI SDK 7 providers build `v4` models and
// `wrapLanguageModel` returns `v4`; a `v3` model (our scripted provider, the
// SDK's v3 mocks) is still accepted and adapted by the SDK. A check for "v3"
// alone silently skipped every real provider model after the AI SDK 7 upgrade
// (and made the step token cap refuse to run), so every gate asks here.
const WRAPPABLE_SPECS: ReadonlySet<string> = new Set(["v3", "v4"])

/** True for a language model object `wrapLanguageModel` accepts. */
export function isWrappableModel(model: unknown): boolean {
  if (typeof model !== "object" || model === null) return false
  const spec = (model as { specificationVersion?: unknown }).specificationVersion
  return typeof spec === "string" && WRAPPABLE_SPECS.has(spec)
}
