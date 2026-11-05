// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// WHY: app settings panes sent people to Settings > Apps to fix a connection.
// Two of those links (`/settings/apps`) matched no section and silently landed
// on the default settings page, and the working ones (`/settings/admin/apps`,
// `?connect=`) took the reader away from the card that said what was broken.
// A connection is fixed in place: an in-tree card embeds the credential form
// (InlineConnectForm), an app's UI opens the kernel dialog with
// `app.openConnectDialog`. Settings > Apps itself (modules/settings) is the
// one place these URLs belong. An app's own settings page,
// `/settings/apps/<appId>`, is a legitimate link and stays allowed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const WEB_SRC = path.resolve(import.meta.dirname, "../..")
const REPO = path.resolve(WEB_SRC, "../../..")
const MODULES = path.join(WEB_SRC, "modules")
const SETTINGS_MODULE = path.join(MODULES, "settings")
const BUNDLED_APPS = path.join(REPO, "bundled-apps")

/** The old management URLs: the Apps admin page, its connect deep link, and the
 *  bare `/settings/apps` (never `/settings/apps/<appId>`). */
const DEAD_SETTINGS_LINK = /\/settings\/admin\/apps|\?connect=|\/settings\/apps\/?(?=$|["'`?])/m

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "node_modules" || full === SETTINGS_MODULE) continue
      yield* sourceFiles(full)
    } else if (/\.tsx?$/.test(name) && !/\.(test|vitest)\.tsx?$/.test(name)) {
      yield full
    }
  }
}

function* appUiRoots(): Generator<string> {
  yield MODULES
  for (const app of readdirSync(BUNDLED_APPS)) {
    const ui = path.join(BUNDLED_APPS, app, "src", "ui")
    if (existsSync(ui)) yield ui
  }
}

describe("no app settings UI links to Settings > Apps", () => {
  it("app UIs fix a connection in place instead of linking to the Apps admin page", () => {
    const offenders: string[] = []
    for (const root of appUiRoots()) {
      for (const file of sourceFiles(root)) {
        // Comments may quote the shape they warn about; code may not.
        const text = readFileSync(file, "utf8")
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n")
        if (DEAD_SETTINGS_LINK.test(text)) offenders.push(path.relative(REPO, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it("the sweep sees what it is looking for", () => {
    expect(DEAD_SETTINGS_LINK.test('navigate("/settings/apps")')).toBe(true)
    expect(DEAD_SETTINGS_LINK.test("navigate('/settings/apps')")).toBe(true)
    expect(DEAD_SETTINGS_LINK.test("href={`/settings/apps`}")).toBe(true)
    expect(DEAD_SETTINGS_LINK.test('href="/settings/apps?tab=x"')).toBe(true)
    expect(DEAD_SETTINGS_LINK.test('<a href="/settings/admin/apps">')).toBe(true)
    expect(DEAD_SETTINGS_LINK.test('href="/settings/admin/apps?connect=gitlab"')).toBe(true)
    expect(DEAD_SETTINGS_LINK.test("const link = `" + "$" + "{base}?connect=gitlab`")).toBe(true)
    // An app's own settings page is a real destination.
    expect(DEAD_SETTINGS_LINK.test('navigate("/settings/apps/tickets")')).toBe(false)
    expect(DEAD_SETTINGS_LINK.test('navigate("/settings/apps/")')).toBe(true)
    expect(DEAD_SETTINGS_LINK.test("href={`/settings/apps/" + "$" + "{appId}`}")).toBe(false)
    expect(DEAD_SETTINGS_LINK.test('href="/settings/invoicing"')).toBe(false)
  })
})
