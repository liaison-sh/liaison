// SPDX-License-Identifier: FSL-1.1-ALv2
export interface ApiResponse {
  status: number
  body: any
  headers: Headers
}

export async function api(
  serverUrl: string,
  path: string,
  options?: {
    method?: string
    body?: unknown
    token?: string
    headers?: Record<string, string>
  },
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...options?.headers,
  }

  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`
  }

  const res = await fetch(`${serverUrl}${path}`, {
    method: options?.method ?? (options?.body ? "POST" : "GET"),
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })

  let body: any
  try {
    body = await res.json()
  } catch {
    const text = await res.text().catch(() => "")
    body = { _rawText: text, _parseError: true }
  }

  return { status: res.status, body, headers: res.headers }
}
