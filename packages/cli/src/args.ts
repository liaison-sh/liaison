// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A small argv parser: positionals, `--flag`, `--flag value`, `--flag=value`,
// repeated flags collected in order. Flags named in `booleans` never take a value.

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string[]>
}

export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const add = (name: string, value: string) => {
    const list = flags.get(name) ?? []
    list.push(value)
    flags.set(name, list)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      add(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (booleans.has(body) || next === undefined || next.startsWith("--")) {
      add(body, "true")
      continue
    }
    add(body, next)
    i++
  }
  return { positionals, flags }
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const list = args.flags.get(name)
  return list ? list[list.length - 1] : undefined
}

export function flagAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? []
}

export function bool(args: ParsedArgs, name: string): boolean {
  const v = flag(args, name)
  return v !== undefined && v !== "false"
}
