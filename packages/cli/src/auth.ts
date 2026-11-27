// SPDX-License-Identifier: FSL-1.1-ALv2
//
// login / logout / whoami / profiles / use.
//
// `login` runs the server's device flow under the client id `liaison-cli`: it
// prints a code and a link, the person approves it in their browser (signed in
// to their org), and the CLI receives a token capped by the server to app
// building and logs (and the reads or admin scopes the person asked for with
// --admin / --config / --scope). The approval page lists every scope.

import { spawn } from "node:child_process"
import { hostname, platform } from "node:os"
import { bool, flag, flagAll, type ParsedArgs } from "./args"
import {
  CliError,
  Client,
  normalizeHost,
  publicRequest,
  refreshCookieFrom,
  tokenClaims,
} from "./http"
import {
  deleteCredentials,
  readCredentials,
  readProfiles,
  writeCredentials,
  writeProfiles,
} from "./store"

export const CLIENT_ID = "liaison-cli"
export const DEFAULT_SCOPES = ["kernel:apps:build", "kernel:apps:logs"]
/** `--config`: what the remote `config apply` sections need. Each change is still a card. */
export const CONFIG_SCOPES = [
  "kernel:roles:admin",
  "kernel:agents:admin",
  "kernel:apps:admin",
  "kernel:skills:read",
  "kernel:skills:write",
  "kernel:routines:read",
  "kernel:routines:write",
]

export interface Io {
  out: (line: string) => void
  err: (line: string) => void
}

/** The profile a command acts on: --profile, LIAISON_PROFILE, the current one, or "default". */
export function profileName(args: ParsedArgs): string {
  return flag(args, "profile") ?? process.env.LIAISON_PROFILE ?? readProfiles().current ?? "default"
}

/** The signed-in client of the selected profile. */
export function clientFor(args: ParsedArgs): Client {
  const name = profileName(args)
  const profile = readProfiles().profiles[name]
  if (!profile) {
    throw new CliError(
      `No profile '${name}'. Sign in first: liaison login --host <your Liaison address>${name === "default" ? "" : ` --profile ${name}`}`,
    )
  }
  return new Client(name, profile.host)
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function login(args: ParsedArgs, io: Io): Promise<void> {
  const rawHost = flag(args, "host") ?? args.positionals[0]
  if (!rawHost)
    throw new CliError("Usage: liaison login --host <your Liaison address> [--profile <name>]")
  const host = normalizeHost(rawHost)
  const name = flag(args, "profile") ?? process.env.LIAISON_PROFILE ?? "default"

  const scopes = new Set(DEFAULT_SCOPES)
  if (bool(args, "admin")) scopes.add("kernel:apps:admin")
  if (bool(args, "config")) for (const s of CONFIG_SCOPES) scopes.add(s)
  for (const s of flagAll(args, "scope"))
    for (const part of s.split(",")) if (part.trim()) scopes.add(part.trim())

  const label = flag(args, "device-label") ?? `liaison CLI on ${hostname()} (${platform()})`
  const { data: started } = await publicRequest<{
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresIn: number
  }>(host, "POST", "/api/auth/device-flow/initiate", {
    clientId: CLIENT_ID,
    scopes: [...scopes],
    deviceLabel: label,
  })

  io.out(`To sign in, open this link in a browser where you are signed in to ${host}:`)
  io.out(`  ${started.verificationUri}`)
  io.out(
    `and check that it shows the code ${started.userCode}. It asks for: ${[...scopes].join(", ")}.`,
  )
  if (!bool(args, "no-browser")) openBrowser(started.verificationUri)

  const deadline = Date.now() + started.expiresIn * 1000
  let interval = Number(process.env.LIAISON_CLI_POLL_MS ?? 5000)
  while (Date.now() < deadline) {
    await sleep(interval)
    const { res, data } = await publicRequest<{ status: string; accessToken?: string }>(
      host,
      "GET",
      `/api/auth/device-flow/poll/${encodeURIComponent(started.deviceCode)}?client_id=${CLIENT_ID}`,
    )
    if (res.status === 429) {
      interval += 2000
      continue
    }
    if (data.status === "authorization_pending") continue
    if (data.status === "denied") throw new CliError("The sign-in was denied.")
    if (data.status === "expired") throw new CliError("The code expired. Run liaison login again.")
    if (data.status === "approved" && data.accessToken) {
      const refreshCookie = refreshCookieFrom(res)
      writeCredentials(name, {
        accessToken: data.accessToken,
        ...(refreshCookie ? { refreshCookie } : {}),
      })
      const claims = tokenClaims(data.accessToken)
      const file = readProfiles()
      file.profiles[name] = {
        host,
        ...(typeof claims.orgId === "string" ? { orgId: claims.orgId } : {}),
      }
      file.current = name
      writeProfiles(file)
      const client = new Client(name, host)
      const me = await client
        .request<{ email?: string; name?: string }>("GET", "/api/users/me")
        .catch(() => null)
      if (me?.email) {
        file.profiles[name] = { ...file.profiles[name]!, email: me.email }
        writeProfiles(file)
      }
      io.out(`Signed in to ${host}${me?.email ? ` as ${me.email}` : ""} (profile ${name}).`)
      if (!refreshCookie)
        io.out("This server gave no refresh token: sign in again when the token ends.")
      return
    }
  }
  throw new CliError("The code expired. Run liaison login again.")
}

export async function logout(args: ParsedArgs, io: Io): Promise<void> {
  const name = profileName(args)
  const file = readProfiles()
  const profile = file.profiles[name]
  const creds = readCredentials(name)
  if (profile && creds?.refreshCookie) {
    // Ends the session on the server too; best effort.
    await fetch(`${profile.host}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: `${creds.refreshCookie.name}=${creds.refreshCookie.value}`,
        authorization: `Bearer ${creds.accessToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    }).catch(() => undefined)
  }
  deleteCredentials(name)
  if (profile) {
    delete file.profiles[name]
    if (file.current === name) delete file.current
    writeProfiles(file)
  }
  io.out(profile ? `Signed out of ${profile.host} (profile ${name}).` : `No profile '${name}'.`)
}

export async function whoami(args: ParsedArgs, io: Io): Promise<void> {
  const client = clientFor(args)
  const me = await client.request<{ email?: string; name?: string; displayName?: string }>(
    "GET",
    "/api/users/me",
  )
  const claims = client.claims
  io.out(`${me.email ?? "?"} on ${client.host} (profile ${client.profile})`)
  if (typeof claims.orgId === "string") io.out(`org: ${claims.orgId}`)
  io.out(`scopes: ${client.scopes.join(", ") || "(none)"}`)
}

export function profiles(args: ParsedArgs, io: Io): void {
  const file = readProfiles()
  const names = Object.keys(file.profiles)
  if (names.length === 0) {
    io.out("No profiles. Sign in with: liaison login --host <your Liaison address>")
    return
  }
  const current = profileName(args)
  for (const n of names) {
    const p = file.profiles[n]!
    io.out(`${n === current ? "*" : " "} ${n}  ${p.host}${p.email ? `  ${p.email}` : ""}`)
  }
}

export function useProfile(args: ParsedArgs, io: Io): void {
  const name = args.positionals[0]
  const file = readProfiles()
  if (!name || !file.profiles[name])
    throw new CliError(
      `Usage: liaison use <profile> (one of: ${Object.keys(file.profiles).join(", ") || "none"})`,
    )
  file.current = name
  writeProfiles(file)
  io.out(`Using profile ${name} (${file.profiles[name]!.host}).`)
}
