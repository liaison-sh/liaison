// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ONLY module that may import @tauri-apps/api.
//
// The overlay is injected into apps/web's page, which is also served in a
// browser with no Tauri at all, and every later 6b module is a component that
// must be renderable under jsdom. Keeping the whole shell surface behind this
// one re-export means a test replaces one module rather than stubbing a global
// the bundler has already inlined, and a stray import in a component is a lint
// away from being caught rather than a runtime crash in the browser build.
export { invoke } from "@tauri-apps/api/core"
export { listen } from "@tauri-apps/api/event"
