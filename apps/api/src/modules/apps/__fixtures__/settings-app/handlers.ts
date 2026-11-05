// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/correctness/noUnusedVariables: handlers are resolved by manifest export name inside the sandbox
//
// Tool handlers of the `settingsfx` fixture app (descriptor.ts), used by the
// declarative-settings route tests. Evaluated raw inside QuickJS: no imports,
// and every function name is unique across the fixtures (script scope).

/** The value object a `{ tool: { get, set } }` field section reads. */
async function settingsFxRemoteGet(_params: unknown) {
  return { remote: { mode: "a", gated: false }, untouched: "kept" }
}

/** Echoes what it was asked to store, so a test sees the object the route built. */
async function settingsFxRemoteSet(params: unknown) {
  return { stored: params }
}

async function settingsFxRemoteSetGated(params: unknown) {
  return { stored: params }
}

async function settingsFxAddressSetGated(params: unknown) {
  return { stored: params }
}
