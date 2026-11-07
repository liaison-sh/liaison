// SPDX-License-Identifier: FSL-1.1-ALv2
// Workers parity fixture B: the target of wparity's nested hop.

export async function echo(p: { v: string }) {
  return { echo: p.v, from: "wparityb" }
}

export async function storeGet(p: { c: string; id: string }, ctx: any) {
  const doc = await ctx.store.get(p.c, p.id)
  return doc ? { id: doc.id, data: doc.data, version: doc.version } : doc
}
