// SPDX-License-Identifier: FSL-1.1-ALv2
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

interface Ctx {
  executeTool: (toolName: string, paramsJson: string) => Promise<string>
}

async function internalCallback(params: any, ctx: Ctx): Promise<unknown> {
  if (params?.cycle) {
    const env = JSON.parse(
      await ctx.executeTool("test-bridge-b:callA", JSON.stringify({ cycle: true })),
    )
    if (env.error) return { error: env.error }
    return env.data
  }
  return { data: { received: params?.payload ?? null } }
}

async function callA(params: any, ctx: Ctx): Promise<unknown> {
  const env = JSON.parse(
    await ctx.executeTool(
      "test-bridge-a:callB",
      JSON.stringify({ payload: params?.payload, cycle: params?.cycle }),
    ),
  )
  if (env.error) return { error: env.error }
  return env.data
}
