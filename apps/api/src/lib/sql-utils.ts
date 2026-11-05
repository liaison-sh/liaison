// SPDX-License-Identifier: FSL-1.1-ALv2
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
