#!/usr/bin/env node

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison`, the remote command line for a Liaison organization. It talks to
// the org's Liaison address over HTTPS as the signed-in person, with a token
// the server caps (no server access, no database, no server secret).
//
// The server's own `liaison` command (provisioning, imports, operator tasks)
// runs on the server and is a different program: `docs/provisioning-cli.md`.

import * as apps from "./apps"
import { parseArgs } from "./args"
import * as auth from "./auth"
import { configApply } from "./config-apply"
import { ApiError, CLI_VERSION, CliError } from "./http"

const BOOLEANS = new Set([
  "admin",
  "config",
  "no-browser",
  "wait",
  "yes",
  "withdraw",
  "follow",
  "fresh",
  "verbose",
  "no-push",
  "dry-run",
  "help",
  "version",
])

const HELP = `liaison ${CLI_VERSION}: your Liaison organization from the command line

Sign in
  liaison login --host <address> [--profile <name>] [--admin] [--config] [--scope <scope>]...
      Device sign-in: approve the code in your browser. The token carries app
      building and app logs; --admin adds kernel:apps:admin (approving an app's
      interface), --config adds what config apply needs, --scope adds a read scope.
  liaison logout | whoami | profiles | use <profile>

Your org's own apps (run in the app's folder, or pass --dir)
  liaison apps init <name> [--title <t>] [--template store-crud|read-only]
  liaison apps push [--message <m>]         save the files as the next version, build and type-check
  liaison apps test [--tool <t> --params <json>] [--fresh] [--verbose]
                                            run tests/*.json cases in the read-only preview
  liaison apps publish [--wait] [--n <version>]
                                            ask for approval to install; --wait follows the card
  liaison apps status | logs [--follow] [--level <l>] | rollback [--to <version>] [--wait]
  liaison apps pull [--n <version>] | list | link <draft id>
  liaison apps ui-consent [--yes] [--withdraw]
                                            let the app's interface run with your session (asks first)
  liaison approvals wait <approval id>

Configuration
  liaison config apply <file> [--dry-run]   roles, agents, apps, skills, routines (each change is an approval card)

Every command takes --profile <name>. Docs: https://liaison.sh/docs (Build an app for your org).`

const SERVER_COMMANDS = new Set([
  "api-connector",
  "app",
  "connect",
  "disconnect",
  "guide",
  "setup",
  "agent",
  "tickets",
  "projects",
  "invoicing",
  "slack",
  "search",
  "export",
  "contacts",
  "mailbox",
  "org",
  "routines",
  "seed",
  "keys",
  "team",
  "erase-user",
  "tour",
])

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, BOOLEANS)
  const [cmd, sub, ...rest] = args.positionals
  const io: auth.Io = { out: (l) => console.log(l), err: (l) => console.error(l) }
  const shifted = (n: number) => ({ ...args, positionals: args.positionals.slice(n) })
  if (cmd === "version" || args.flags.has("version")) {
    console.log(CLI_VERSION)
    return 0
  }
  if (!cmd || cmd === "help" || args.flags.has("help")) {
    console.log(HELP)
    return 0
  }
  switch (cmd) {
    case "login":
      await auth.login(shifted(1), io)
      return 0
    case "logout":
      await auth.logout(shifted(1), io)
      return 0
    case "whoami":
      await auth.whoami(shifted(1), io)
      return 0
    case "profiles":
      auth.profiles(shifted(1), io)
      return 0
    case "use":
      auth.useProfile(shifted(1), io)
      return 0
    case "apps": {
      const a = shifted(2)
      switch (sub) {
        case "init":
          await apps.init(a, io)
          return 0
        case "push":
          return apps.push(a, io)
        case "pull":
          await apps.pull(a, io)
          return 0
        case "test":
          return apps.test(a, io)
        case "publish":
        case "install":
          return apps.publish(a, io)
        case "status":
          await apps.status(a, io)
          return 0
        case "logs":
          await apps.logs(a, io)
          return 0
        case "rollback":
          return apps.rollback(a, io)
        case "list":
          await apps.list(a, io)
          return 0
        case "link":
          await apps.link(a, io)
          return 0
        case "ui-consent":
          return apps.uiConsent(a, io)
        default:
          throw new CliError(`Unknown: liaison apps ${sub ?? ""}. See liaison help.`)
      }
    }
    case "approvals":
      if (sub === "wait") return apps.approvalsWait(shifted(2), io)
      throw new CliError(
        "Usage: liaison approvals wait <approval id>. Approvals are decided in Liaison, by a person.",
      )
    case "config":
      if (sub === "apply") return configApply(shifted(2), io)
      throw new CliError(
        `liaison config ${sub ?? ""}: only config apply runs remotely. The rest runs on the server.`,
      )
    default:
      if (SERVER_COMMANDS.has(cmd)) {
        throw new CliError(
          `liaison ${cmd} ${rest.length || sub ? "..." : ""}runs on the Liaison server itself (it needs the database), not from this remote CLI. See docs/provisioning-cli.md.`,
        )
      }
      throw new CliError(`Unknown command: ${cmd}. See liaison help.`)
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ApiError) {
      console.error(`Error (${err.status}${err.code ? ` ${err.code}` : ""}): ${err.message}`)
      process.exit(err.exitCode)
    }
    if (err instanceof CliError) {
      console.error(err.message)
      process.exit(err.exitCode)
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  },
)
