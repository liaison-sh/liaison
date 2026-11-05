// SPDX-License-Identifier: FSL-1.1-ALv2
import { simpleParser } from "mailparser"
import { SMTPServer, type SMTPServerSession } from "smtp-server"

export type CapturedMessage = {
  from: string[]
  to: string[]
  cc: string[]
  subject: string
  headers: Record<string, string>
  html: string
  text: string
  raw: Buffer
}

export type InjectionApi = {
  setLatency(ms: number): void
  setRejectNext(count: number, code: number): void
  setAmbiguousNext(count: number): void
  setAuthFailure(matcher: ((email: string) => boolean) | null): void
}

export type SmtpFixture = {
  host: string
  port: number
  captured: CapturedMessage[]
  inject: InjectionApi
  close(): Promise<void>
}

export type SmtpFixtureOptions = {
  authRequired?: boolean
}

function headersToRecord(map: Map<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of map.entries()) {
    if (typeof v === "string") out[k] = v
    else if (Array.isArray(v)) out[k] = v.map((x) => String(x)).join(", ")
    else if (v && typeof (v as { value?: unknown }).value === "string") {
      out[k] = (v as { value: string }).value
    } else {
      try {
        out[k] = JSON.stringify(v)
      } catch {
        out[k] = String(v)
      }
    }
  }
  return out
}

function addressList(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(addressList)
  const v = value as { value?: Array<{ address?: string }>; address?: string }
  if (Array.isArray(v.value)) {
    return v.value.map((a) => a.address ?? "").filter(Boolean)
  }
  if (typeof v.address === "string") return [v.address]
  return []
}

export async function startSmtpFixture(options: SmtpFixtureOptions = {}): Promise<SmtpFixture> {
  const captured: CapturedMessage[] = []

  let latencyMs = 0
  const rejectQueue: Array<{ remaining: number; code: number }> = []
  let ambiguousRemaining = 0
  let authFailureMatcher: ((email: string) => boolean) | null = null

  const inject: InjectionApi = {
    setLatency(ms) {
      latencyMs = Math.max(0, ms | 0)
    },
    setRejectNext(count, code) {
      if (count > 0) rejectQueue.push({ remaining: count, code })
    },
    setAmbiguousNext(count) {
      ambiguousRemaining = Math.max(0, count | 0)
    },
    setAuthFailure(matcher) {
      authFailureMatcher = matcher
    },
  }

  const server = new SMTPServer({
    authOptional: !options.authRequired,
    disabledCommands: options.authRequired ? ["STARTTLS"] : ["STARTTLS", "AUTH"],
    onAuth(auth, _session, callback) {
      if (authFailureMatcher?.(auth.username ?? "")) {
        return callback(new Error("Invalid credentials"))
      }
      callback(null, { user: auth.username ?? "anon" })
    },
    onConnect(_session, callback) {
      if (rejectQueue.length > 0) {
        const head = rejectQueue[0]
        head.remaining -= 1
        if (head.remaining <= 0) rejectQueue.shift()
        const err = new Error(`SMTP rejected (${head.code})`) as Error & {
          responseCode?: number
        }
        err.responseCode = head.code
        return callback(err)
      }
      callback()
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", async () => {
        const raw = Buffer.concat(chunks)
        if (ambiguousRemaining > 0) {
          ambiguousRemaining -= 1
          if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs))
          // Drop connection without ACK after DATA so client gets ambiguous outcome.
          try {
            session.transmissionType = "SMTP"
          } catch {
            // ignore
          }
          // smtp-server expects callback; trigger a reset error to drop the socket.
          const err = new Error("ambiguous-disconnect") as Error & {
            responseCode?: number
          }
          err.responseCode = 451
          return callback(err)
        }
        try {
          const mail = await simpleParser(raw)
          captured.push({
            from: addressList(mail.from),
            to: addressList(mail.to),
            cc: addressList(mail.cc),
            subject: mail.subject ?? "",
            headers: headersToRecord(mail.headers),
            html: typeof mail.html === "string" ? mail.html : "",
            text: typeof mail.text === "string" ? mail.text : "",
            raw,
          })
          if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs))
          callback()
        } catch (err) {
          callback(err as Error)
        }
      })
      stream.on("error", (err) => callback(err))
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = server.server.address()
  const port =
    typeof address === "object" && address && "port" in address ? (address.port as number) : 0
  const host = "127.0.0.1"

  let closed = false
  return {
    host,
    port,
    captured,
    inject,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
