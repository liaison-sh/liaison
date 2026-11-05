// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refresh token is a month-long session. It must live where the OS keeps
// secrets (the keychain, the Android keystore), never in plain app
// preferences, and the Android app must not hand its preferences to the
// device backup, where a restored or copied backup carries the session off the
// phone.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = import.meta.dir
const MANIFEST = path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml")
const MAIN = path.join(ROOT, "src", "main.ts")

describe("the mobile session token at rest", () => {
  it("positive control: the push receipt credential is already in the keychain", () => {
    const receipts = readFileSync(path.join(ROOT, "src", "receipts.ts"), "utf8")
    expect(receipts).toContain("keychain")
  })

  it("Android keeps app preferences out of the device backup", () => {
    const manifest = readFileSync(MANIFEST, "utf8")
    const backupOff = manifest.includes('android:allowBackup="false"')
    const excluded =
      manifest.includes("android:dataExtractionRules=") &&
      manifest.includes("android:fullBackupContent=")
    expect(backupOff || excluded).toBe(true)
  })

  it("the refresh token store is not plain Capacitor Preferences", () => {
    const main = readFileSync(MAIN, "utf8")
    // preferencesRefreshStore is serverList.refreshStoreFor(...), and the
    // server list is created over this store.
    expect(main).toContain(
      "export const preferencesRefreshStore: RefreshTokenStore = serverList.refreshStoreFor(",
    )
    const list = main.match(
      /export const serverList: ServerList = createServerList\(\{\s*store: (\w+)/,
    )
    expect(list).not.toBeNull()
    const storeName = list?.[1] ?? ""
    const storeDecl = main.slice(
      main.indexOf(`export const ${storeName}`),
      main.indexOf("export const serverList"),
    )
    expect(storeDecl).not.toContain("Preferences.set")
  })
})
