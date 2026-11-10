// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where an installed copy of Liaison asks for its next version.
//
// D13: one build for every fork, and updates come from the Liaison open source
// project, never from a deployment. A company runs a Liaison server; so does a
// fork; neither of them ships Liaison. If the endpoint here ever named a
// deployment, that deployment's operator would decide what binary every user
// of every OTHER deployment runs next, and the updater signature would not
// help: the manifest is fetched before any signature is checked.
//
// So the endpoint is a host the project owns, and this file exists to say that
// a hostname belonging to a deployment is a failing test.
//
// It is downloads.liaison.sh and no longer a GitHub release asset. The
// repository is PRIVATE, so releases/latest/download answers 404 to every
// anonymous client: not a broken link somebody sees, an update channel that is
// dead on every installed copy with nothing said. The bytes are the same bytes
// and the updater signature is still the project's, so nothing about D13
// changes; only the host that serves them does.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DOWNLOADS_HOST, MANIFEST_KEY, UPDATER_ENDPOINT } from "./ci/downloads"

const config = JSON.parse(
  readFileSync(path.join(import.meta.dir, "src-tauri/tauri.conf.json"), "utf8"),
) as { plugins?: { updater?: { endpoints?: string[] } } }

const endpoints = config.plugins?.updater?.endpoints ?? []

describe("the updater endpoint", () => {
  it("is exactly one url", () => {
    // Tauri tries each endpoint in order and takes the first that answers. A
    // second one is a second thing that decides what users install.
    expect(endpoints).toHaveLength(1)
  })

  it("is the project's own downloads host over https", () => {
    const url = new URL(endpoints[0] ?? "")
    expect(url.protocol).toBe("https:")
    expect(url.hostname).toBe(DOWNLOADS_HOST)
    expect(url.pathname).toBe(`/${MANIFEST_KEY}`)
  })

  it("is the one string the mirror publishes the manifest at", () => {
    // The config compiled into the app and the object key the mirror writes
    // are the SAME constant. Two spellings of this is an update channel that
    // points one path away from where the manifest actually lands, and the
    // only symptom is that no machine is ever offered a release.
    expect(endpoints[0]).toBe(UPDATER_ENDPOINT)
  })

  it("is not a private repository's release asset", () => {
    // liaison-sh/liaison is private. An anonymous GET of any asset on it, and
    // of releases/latest/download, answers 404, so an endpoint there is an
    // updater that can never succeed and a download link that can never work.
    expect(endpoints[0]).not.toContain("github.com")
    expect(endpoints[0]).not.toContain("releases/latest/download")
  })

  it("names no deployment host", () => {
    // Every deployment this epic knows about, plus the shape of one.
    const serialized = endpoints.join(" ")
    for (const host of [
      "fabrikam.example",
      "liaison.fabrikam.example",
      "api.fabrikam.example",
      "tailspin",
      "localhost",
    ]) {
      expect(serialized).not.toContain(host)
    }
  })

  it("interpolates nothing a server could steer", () => {
    // Tauri substitutes {{target}}, {{arch}} and {{current_version}} into the
    // url. A rolling asset needs none of them, and each one is a value the
    // running app hands to whoever answers.
    expect(endpoints[0]).not.toContain("{{")
  })
})
