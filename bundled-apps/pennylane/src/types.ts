// SPDX-License-Identifier: FSL-1.1-ALv2
export type PennylaneScope = "company" | "firm"
export interface Filter {
  field: string
  operator: string
  value: unknown
}
export interface Page<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
}
export type PnlClass = "revenue" | "cogs" | "opex" | "other"
