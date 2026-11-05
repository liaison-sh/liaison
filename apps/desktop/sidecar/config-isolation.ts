// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Keeping the operator's own Claude Code connectors out of a role agent's
// session, WITHOUT losing the login every local turn runs on (A29).
//
// The SDK spawns the Claude Code CLI, which reads the machine owner's own
// config directory: the day one spike measured a Liaison turn seeing that
// operator's personal claude.ai connectors (Drive, Gmail, Calendar). Pointing
// `CLAUDE_CONFIG_DIR` at a private directory removes them and, on its own,
// takes the login with it. This module is why it no longer does.
//
// WHAT THE CLI ACTUALLY READS, read out of the pinned CLI binary rather than
// assumed. Its credential store picks a name and a directory like this:
//
//   var Y7 = "-credentials"
//   function b_() {                       // the plaintext store's directory
//     let n = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
//     if (n !== undefined) return (n || join(homedir(), ".claude")).normalize("NFC")
//     return configDir()                  // CLAUDE_CONFIG_DIR, else ~/.claude
//   }
//   function iH(n = "") {                 // the macOS keychain SERVICE name
//     let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
//         t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
//         r = e !== undefined ? e.normalize("NFC") : configDir(),
//         c = t ? "" : `-${sha256(r).substring(0, 8)}`
//     return `Claude Code${OAUTH_FILE_SUFFIX}${n}${c}`
//   }
//
// So on macOS the credential is NOT a file at all: it is a keychain item read
// with `security find-generic-password -s "Claude Code-credentials" -a $USER`,
// and setting `CLAUDE_CONFIG_DIR` alone appends a hash of that directory to
// the service name, which is exactly how the first isolation attempt lost the
// login (b502f2a4 then 9d0e4ae9).
//
// `CLAUDE_SECURESTORAGE_CONFIG_DIR` is the seam that separates the two. Set to
// the EMPTY string it makes the credential store default again (`t` is true,
// so the keychain service name carries no suffix, and the plaintext store
// falls back to `~/.claude`) while `CLAUDE_CONFIG_DIR` still moves everything
// else: settings, MCP servers, connectors, projects, history. The session
// keeps the operator's login and loses the operator's connectors.
//
// The plaintext credential file is copied across as well, because the CLI uses
// it wherever the keychain is not available (Linux, Windows, a headless Mac).

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The CLI's own config directory variable. */
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
/** The CLI's credential store variable, which the isolation deliberately pins. */
export const SECURESTORAGE_CONFIG_DIR_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR"
/** The CLI's plaintext credential file, inside whichever config dir it uses. */
export const CREDENTIAL_FILE = ".credentials.json"
/** The directory the isolated config lives in, under the app's own data dir. */
export const ISOLATED_DIR_NAME = "claude-config"
/** The app's folder inside the OS data directory. */
export const APP_DIR_NAME = "liaison-desktop"

/** Where this app may keep per-user state, per OS convention. */
export function appDataDir(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_DIR_NAME)
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), APP_DIR_NAME)
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR_NAME)
}

/** The config directory the OPERATOR's own Claude Code uses. */
export function realClaudeConfigDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const named = env[CLAUDE_CONFIG_DIR_ENV]
  return named?.trim() ? named : join(home, ".claude")
}

/** The private config directory a non-personal agent's session runs on. */
export function isolatedConfigDir(dataDir: string = appDataDir()): string {
  return join(dataDir, ISOLATED_DIR_NAME)
}

/**
 * Creates the private config directory (owner only) and carries the CLI's
 * plaintext credential file into it, if there is one. Nothing else is copied:
 * settings, MCP servers and connectors are exactly what this session must not
 * inherit.
 *
 * Returns what landed there, so a caller can say what it carried across.
 */
export function prepareIsolatedConfig(
  options: { realConfigDir?: string; isolatedDir?: string } = {},
): { dir: string; copied: string[] } {
  const realConfigDir = options.realConfigDir ?? realClaudeConfigDir()
  const dir = options.isolatedDir ?? isolatedConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Set again on an existing directory: a create time mode does nothing to a
  // directory that is already there, and this one holds a credential.
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows has no mode to set; the directory's inherited ACL stands.
  }
  const copied: string[] = []
  const source = join(realConfigDir, CREDENTIAL_FILE)
  if (existsSync(source)) {
    const target = join(dir, CREDENTIAL_FILE)
    copyFileSync(source, target)
    try {
      chmodSync(target, 0o600)
    } catch {
      // As above.
    }
    copied.push(CREDENTIAL_FILE)
  }
  return { dir, copied }
}

/**
 * The environment the CLI child runs with. The config directory moves; the
 * credential store deliberately does NOT, which is the whole difference
 * between this and the isolation that lost the login.
 */
export function isolationEnv(dir: string): Record<string, string> {
  return { [CLAUDE_CONFIG_DIR_ENV]: dir, [SECURESTORAGE_CONFIG_DIR_ENV]: "" }
}
