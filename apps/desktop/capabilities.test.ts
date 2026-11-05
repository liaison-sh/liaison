// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell spawns its sidecar from RUST (`app.shell().sidecar(...)` in
// sidecar.rs). A Rust side spawn does not consult the webview's capability
// file at all, so a `shell:allow-execute` grant here bought the spawn nothing
// and handed the PAGE a process launcher instead. With `args: true` on it the
// page could have chosen the argv, which is the whole session: the MCP config
// path, the model, the folder, the permission mode. It is gone, and this file
// pins the exact set that is left so it cannot come back by accident.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const SRC_TAURI = path.join(import.meta.dir, "src-tauri")
const capability = JSON.parse(
  readFileSync(path.join(SRC_TAURI, "capabilities/default.json"), "utf8"),
)
const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"))

/**
 * Every permission the desktop window is granted. `core:default` used to sit
 * where the first two entries are: it is nine plugin bundles at once (app,
 * event, image, menu, path, resources, tray, webview, window), and the overlay
 * reaches exactly one of them, to listen for the shell's events. The app's own
 * `invoke` commands are not in here because commands declared with
 * `generate_handler!` are not permission gated; only plugin commands are.
 */
const EXPECTED_PERMISSIONS = [
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "dialog:allow-open",
  "deep-link:allow-get-current",
  // The plugin's permission commands answer "granted" on a desktop whatever
  // the system says; the window asks the shell's own
  // `notification_os_permission`, and raises through the shell's own
  // `raise_notification` (LIF-18), so `notify` is not granted. Walk D21: the
  // plugin's own page script still reads is_permission_granted on every load,
  // so that read is granted; request_permission is not.
  "notification:allow-is-permission-granted",
  // The app's own version, which the page names to its server and compares
  // with the oldest the server supports (apps/web lib/client-version.ts).
  // Only this one command of the app plugin; not `core:app:default`.
  "core:app:allow-version",
]

describe("the desktop capability", () => {
  it("grants exactly the permissions the window needs and nothing else", () => {
    expect(capability.permissions).toEqual(EXPECTED_PERMISSIONS)
  })

  it("grants no shell permission of any kind", () => {
    const serialized = JSON.stringify(capability.permissions)
    expect(serialized).not.toContain("shell:")
  })

  it("grants no argv passthrough anywhere in the file", () => {
    // `args: true` on a scoped execute grant is "any argv you like". Written
    // as a plain substring check so it is caught wherever it is nested.
    expect(JSON.stringify(capability).replace(/\s/g, "")).not.toContain('"args":true')
  })

  it("describes itself as what it actually grants", () => {
    const description: string = capability.description
    expect(description).toContain("folder picker")
    expect(description).toContain("notification")
    expect(description).not.toContain("sidecar")
  })

  it("declares the sidecar as an externalBin under the binaries prefix", () => {
    // The externalBin declaration is how the binary is BUNDLED and how the
    // Rust side resolves `sidecar("liaison-sidecar")`. It is unrelated to the
    // webview capability above and must survive its removal.
    expect(config.bundle.externalBin).toEqual(["binaries/liaison-sidecar"])
  })
})

// Reading ONE capability file proves nothing about the others: a wildcard
// added in a second file would have been invisible to every assertion above.
// Every file under capabilities/ is enumerated here instead, so a new one is
// covered the day it lands rather than the day somebody remembers it.
const CAPABILITY_DIR = path.join(SRC_TAURI, "capabilities")
const capabilityFiles = readdirSync(CAPABILITY_DIR).filter((name) => name.endsWith(".json"))

describe("every capability file", () => {
  it("finds at least the default one, so an empty read cannot pass", () => {
    expect(capabilityFiles).toContain("default.json")
  })

  it.each(capabilityFiles)("grants no wildcard scope in %s", (name) => {
    const parsed = JSON.parse(readFileSync(path.join(CAPABILITY_DIR, name), "utf8"))
    for (const permission of parsed.permissions as unknown[]) {
      if (typeof permission === "string") continue
      // A scoped permission's allow/deny entries are where a "*" would hide.
      const scoped = permission as { allow?: unknown[]; deny?: unknown[] }
      for (const entry of [...(scoped.allow ?? []), ...(scoped.deny ?? [])]) {
        expect(JSON.stringify(entry)).not.toContain("*")
      }
    }
  })

  it.each(capabilityFiles)("grants no shell execute or shell open in %s", (name) => {
    const parsed = JSON.parse(readFileSync(path.join(CAPABILITY_DIR, name), "utf8"))
    expect(JSON.stringify(parsed.permissions)).not.toContain("shell:")
  })

  it.each(capabilityFiles)("grants no plugin default bundle in %s", (name) => {
    const parsed = JSON.parse(readFileSync(path.join(CAPABILITY_DIR, name), "utf8"))
    const bare = (parsed.permissions as unknown[]).filter((p) => typeof p === "string")
    // A `default` bundle, core's included, turns on every command the plugin
    // ships. Nothing here is granted that way.
    for (const permission of bare as string[]) {
      expect(permission.endsWith(":default")).toBe(false)
    }
  })
})

describe("the content security policy", () => {
  // `csp: null` is no policy at all: the webview renders apps/web with no
  // restriction on where a script may come from, which is the difference
  // between one injected string being a bug and it being remote code.
  const csp: string | null = config.app?.security?.csp ?? null

  it("is set at all", () => {
    expect(csp).not.toBeNull()
    expect(typeof csp).toBe("string")
  })

  it("runs scripts from the reviewed sources and no others", () => {
    // `toContain("script-src 'self'")` said nothing once the directive grew a
    // second source: it matches just as happily with a wildcard appended. So
    // the source LIST is pinned instead, in order, and adding or removing one
    // fails here. D11: the web build's own script policy and nothing more. No
    // installed app's bundle runs in the page any longer: a first-party
    // bundled app is compiled into the build, any other app runs in the
    // shell's sandboxed frame (src-tauri/src/app_frame.rs).
    const script = /script-src ([^;]+)/.exec(csp ?? "")?.[1] ?? ""
    expect(script.split(/\s+/).filter(Boolean)).toEqual(["'self'", "'wasm-unsafe-eval'"])
    expect(csp).not.toContain("default-src *")
  })

  // A mailbox password made before PBKDF2 derives its key with Argon2id, which
  // is WebAssembly. WebKit refuses to compile WebAssembly under a script-src
  // without 'wasm-unsafe-eval' ("Refused to create a WebAssembly object"), and
  // the blob crypto worker inherits this policy, so without it such a password
  // can never open the mailbox in the shell. 'wasm-unsafe-eval' allows
  // WebAssembly compilation only, never JavaScript eval.
  it("lets the mailbox compile its WebAssembly KDF, and never eval", () => {
    const script = /script-src ([^;]+)/.exec(csp ?? "")?.[1] ?? ""
    expect(script).toContain("'wasm-unsafe-eval'")
    expect(script.split(/\s+/)).not.toContain("'unsafe-eval'")
  })

  // An injected <base> or <form> must not redirect relative script URLs or a
  // submission to another origin. Neither directive falls back to default-src.
  it("pins base-uri and form-action to the shell itself", () => {
    expect(/base-uri ([^;]+)/.exec(csp ?? "")?.[1]).toBe("'self'")
    expect(/form-action ([^;]+)/.exec(csp ?? "")?.[1]).toBe("'self'")
  })

  it("lets the window reach the Liaison box the user named", () => {
    // The server address is entered at first launch, so the origin is not
    // knowable here; what is pinned is that it is an http(s) or websocket
    // origin and not "anything".
    const connect = /connect-src ([^;]+)/.exec(csp ?? "")?.[1] ?? ""
    expect(connect).toContain("'self'")
    expect(connect).toContain("https:")
    expect(connect).toContain("http://localhost:*")
    expect(connect).toContain("ws:")
    expect(connect).toContain("wss:")
  })

  // apps/web boots the personal mailbox's crypto worker from a BLOB url after
  // hashing the source (modules/mailbox/worker-integrity.ts): no shipping
  // browser can SRI-pin a worker, so the hash check plus a narrow worker
  // source is the whole defence. With no `worker-src` at all the policy falls
  // back to `default-src 'self'`, the blob worker is refused, and the caller's
  // own contract on a failed boot is to refuse to unlock: the mailbox is dead
  // in the shell. Driven proof, 2026-09-13: "csp: worker-src blocked blob".
  it("lets the mailbox boot its verified blob worker, and nothing remote", () => {
    const worker = /worker-src ([^;]+)/.exec(csp ?? "")?.[1] ?? ""
    expect(worker).toContain("'self'")
    expect(worker).toContain("blob:")
    expect(worker).not.toContain("https:")
    expect(worker).not.toContain("*")
    // The zod eval refusal is benign (it falls back to a jitless path) and
    // buying silence with 'unsafe-eval' would be paying for noise with the
    // one thing this policy is for.
    expect(csp?.split(/[\s;]+/)).not.toContain("'unsafe-eval'")
  })

  it("loads no plugin, and frames only what the app makes itself", () => {
    expect(csp).toContain("object-src 'none'")
    // apps/web renders a mail body in a srcdoc iframe and an installed app's
    // UI in the shell's own frame scheme (D11), so frames are not forbidden;
    // what is forbidden is a remote one.
    const frame = /frame-src ([^;]+)/.exec(csp ?? "")?.[1] ?? ""
    expect(frame).toContain("'self'")
    expect(frame).not.toContain("https:")
    expect(frame).not.toContain("*")
  })
})

// THE NOTIFICATION GRANT (S7, P1-T6). Of the three commands the plugin
// registers on a desktop (its `init` in lib.rs: notify, request_permission,
// is_permission_granted), only the read its own page script makes, by name (the
// shell raises through its own command), and none of the mobile ones: actions,
// channels, pending and active lists do nothing on a desktop, and a grant for a
// command that does nothing is a grant nobody reviews when it starts doing
// something. A capability for a plugin the shell never registers is a command
// that always fails, so the registration is pinned beside it.
describe("the notification plugin", () => {
  const main = readFileSync(path.join(SRC_TAURI, "src/main.rs"), "utf8")
  const cargo = readFileSync(path.join(SRC_TAURI, "Cargo.toml"), "utf8")

  it("is a dependency and is registered in the shell", () => {
    expect(cargo).toMatch(/^tauri-plugin-notification = /m)
    expect(main).toContain(".plugin(tauri_plugin_notification::init())")
  })

  // P1-T6: raising, and the one read the plugin's own page script makes. The
  // permission commands answer "granted" on a desktop whatever the system
  // says; the page asks the shell's own `notification_os_permission`
  // (desktop_notifications.rs) instead (notifications.test.ts pins that).
  // Walk D21: but the plugin's init script (its window.Notification shim)
  // calls is_permission_granted on every page load, and refused it logged an
  // error each time. It only reads; request_permission stays ungranted.
  it("is granted only the plugin script's read, never notify or request_permission", () => {
    const granted = (capability.permissions as unknown[]).filter(
      (p): p is string => typeof p === "string" && p.startsWith("notification:"),
    )
    expect(granted.sort()).toEqual(["notification:allow-is-permission-granted"])
  })
})

describe("the deep link scheme", () => {
  it("pins liaison as the registered desktop scheme", () => {
    expect(config.plugins?.["deep-link"]?.desktop?.schemes).toEqual(["liaison"])
  })

  // The dialog plugin has no scope object of its own, so "directories only"
  // is enforced by the shell: `pick_folder` is the only dialog command the
  // shell exposes and it only ever picks a folder. What the capability can
  // pin is that nothing ELSE the plugin ships is granted. The bypass
  // confirmation is a RUST side dialog, which needs no grant here.
  it("grants dialog open and no other dialog command", () => {
    const bare = capability.permissions.filter((entry: unknown) => typeof entry === "string")
    expect(bare).toContain("dialog:allow-open")
    for (const forbidden of [
      "dialog:allow-save",
      "dialog:allow-message",
      "dialog:allow-ask",
      "dialog:allow-confirm",
      "dialog:default",
    ]) {
      expect(bare).not.toContain(forbidden)
    }
  })

  it("grants the webview no updater permission at all", () => {
    // The update check runs in RUST, at startup, and asks the user with a
    // native dialog. A Rust side plugin call consults no capability file, so
    // the window needs nothing here: what a grant would add is the PAGE being
    // able to download and install a new binary, which is the one thing an
    // injected script must never be able to do.
    expect(JSON.stringify(capability.permissions)).not.toContain("updater:")
  })

  it("grants the deep link plugin nothing beyond reading the current url", () => {
    const bare = capability.permissions.filter((entry: unknown) => typeof entry === "string")
    for (const forbidden of [
      "deep-link:default",
      "deep-link:allow-register",
      "deep-link:allow-unregister",
    ]) {
      expect(bare).not.toContain(forbidden)
    }
  })
})
