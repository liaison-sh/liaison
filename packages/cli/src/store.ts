// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the CLI keeps its profiles and sign-ins.
//
// - Profiles (name -> host, no secret): `<config dir>/config.json`.
// - Sign-ins (access token, refresh token): the OS keychain when there is one
//   (macOS `security`, Linux `secret-tool`), else `<config dir>/credentials.json`
//   written 0600 in a 0700 directory. `LIAISON_CREDENTIAL_STORE=file` forces the
//   file (a container, a CI job).
// - The config dir is `LIAISON_CONFIG_DIR`, else `$XDG_CONFIG_HOME/liaison`,
//   else `~/.config/liaison` (`%APPDATA%\liaison` on Windows).

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface Profile {
  host: string
  /** From the token at sign-in, shown by `whoami` and `profiles`. */
  orgId?: string
  email?: string
}

export interface ProfilesFile {
  current?: string
  profiles: Record<string, Profile>
}

export interface Credentials {
  accessToken: string
  /** The refresh cookie as the server set it: name and value. */
  refreshCookie?: { name: string; value: string }
  scopes?: string[]
}

const SERVICE = "liaison-cli"

export function configDir(): string {
  if (process.env.LIAISON_CONFIG_DIR) return process.env.LIAISON_CONFIG_DIR
  if (process.platform === "win32" && process.env.APPDATA)
    return join(process.env.APPDATA, "liaison")
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "liaison")
}

function ensureDir(): string {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

/** Written whole, then renamed, mode 0600. */
function writePrivate(path: string, data: unknown): void {
  ensureDir()
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function readProfiles(): ProfilesFile {
  return readJson<ProfilesFile>(join(configDir(), "config.json"), { profiles: {} })
}

export function writeProfiles(file: ProfilesFile): void {
  writePrivate(join(configDir(), "config.json"), file)
}

type Backend = "keychain" | "secret-tool" | "file"

function hasCommand(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore" })
  return r.error === undefined
}

let backendMemo: Backend | null = null
export function credentialBackend(): Backend {
  if (backendMemo) return backendMemo
  const forced = process.env.LIAISON_CREDENTIAL_STORE
  if (forced === "file") backendMemo = "file"
  else if (process.platform === "darwin" && hasCommand("security", ["help"]))
    backendMemo = "keychain"
  else if (
    process.platform === "linux" &&
    process.env.DBUS_SESSION_BUS_ADDRESS &&
    hasCommand("secret-tool", ["--version"])
  )
    backendMemo = "secret-tool"
  else backendMemo = "file"
  return backendMemo
}

const credentialsPath = () => join(configDir(), "credentials.json")

export function readCredentials(profile: string): Credentials | null {
  const backend = credentialBackend()
  let raw: string | null = null
  if (backend === "keychain") {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", profile, "-w"], {
      encoding: "utf8",
    })
    raw = r.status === 0 ? r.stdout.trim() : null
  } else if (backend === "secret-tool") {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "profile", profile], {
      encoding: "utf8",
    })
    raw = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
  } else {
    const all = readJson<Record<string, Credentials>>(credentialsPath(), {})
    return all[profile] ?? null
  }
  if (!raw) return null
  try {
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

export function writeCredentials(profile: string, creds: Credentials): void {
  const backend = credentialBackend()
  const value = JSON.stringify(creds)
  if (backend === "keychain") {
    // `-U` updates in place. The value is an argument of a short-lived child
    // process of this user; the keychain item is readable by this user only.
    const r = spawnSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        profile,
        "-l",
        `Liaison CLI (${profile})`,
        "-w",
        value,
      ],
      { stdio: "ignore" },
    )
    if (r.status === 0) return
  } else if (backend === "secret-tool") {
    const r = spawnSync(
      "secret-tool",
      ["store", `--label=Liaison CLI (${profile})`, "service", SERVICE, "profile", profile],
      { input: value, stdio: ["pipe", "ignore", "ignore"] },
    )
    if (r.status === 0) return
  }
  // The file: the fallback, and where a failed keychain write lands.
  const all = readJson<Record<string, Credentials>>(credentialsPath(), {})
  all[profile] = creds
  writePrivate(credentialsPath(), all)
}

export function deleteCredentials(profile: string): void {
  const backend = credentialBackend()
  if (backend === "keychain") {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", profile], {
      stdio: "ignore",
    })
  } else if (backend === "secret-tool") {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "profile", profile], { stdio: "ignore" })
  }
  const path = credentialsPath()
  if (existsSync(path)) {
    const all = readJson<Record<string, Credentials>>(path, {})
    if (profile in all) {
      delete all[profile]
      writePrivate(path, all)
    }
  }
}
