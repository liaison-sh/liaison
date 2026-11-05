// SPDX-License-Identifier: FSL-1.1-ALv2
// Note: Unit test files (*.test.ts) contain ~79 hardcoded `kernel.` references
// in raw SQL fixtures. These are intentionally NOT converted to schemaRef() because
// unit tests run without SCHEMA_PREFIX. Convert if unit tests ever need isolation.

const SAFE_IDENTIFIER = /^[a-z0-9_]*$/

export function schemaRef(name: string): string {
  const prefix = process.env.SCHEMA_PREFIX ?? ""
  if (!SAFE_IDENTIFIER.test(prefix)) {
    throw new Error(
      `SCHEMA_PREFIX contains unsafe characters: "${prefix}" — must match /^[a-z0-9_]*$/`,
    )
  }
  return `${prefix}${name}`
}
