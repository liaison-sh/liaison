// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Liaison's service worker: Web Push for the browser computer channel (S5, A6)
// and its receipts (A7). Registered by src/modules/notifications/browser-push.ts,
// only in a real browser (never in the desktop or phone shells).
//
// A push carries the server's `notify` frame as JSON. The worker shows it,
// THEN posts a `shown` receipt with the browser device's receipt-only
// credential, which the page left in IndexedDB (the database, store and key
// below repeat src/modules/notifications/device-credential.ts verbatim).
// A missing credential or a failed receipt never fails the push event: the
// notification is shown either way.
//
// ONE USER PER BROWSER (fix2-F1): every push names its recipient by a marker,
// `userTag` (a hash of the user id, apps/api web-push.ts `webPushUserTag`). A
// push whose marker is not the user of the credential this browser holds is
// dropped: neither shown nor receipted. The server already gives an endpoint
// one owner; this is the second lock.
//
// A classic script with no imports, so it is served as it is from the web root.

const CREDENTIAL_DB = "liaison-notifications"
const CREDENTIAL_STORE = "device"
const CREDENTIAL_KEY = "browser"

self.addEventListener("install", () => {
  void self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  if (self.clients && typeof self.clients.claim === "function") {
    event.waitUntil(self.clients.claim())
  }
})

function readDevice() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CREDENTIAL_DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) db.createObjectStore(CREDENTIAL_STORE)
      }
      req.onerror = () => resolve(null)
      req.onsuccess = () => {
        try {
          const get = req.result
            .transaction(CREDENTIAL_STORE, "readonly")
            .objectStore(CREDENTIAL_STORE)
            .get(CREDENTIAL_KEY)
          get.onsuccess = () => {
            const rec = get.result
            resolve(rec && typeof rec.credential === "string" ? rec : null)
          }
          get.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }
    } catch {
      resolve(null)
    }
  })
}

/** The marker the server puts on a push for `userId` (sha-256, hex). */
async function userTagOf(userId) {
  const bytes = new TextEncoder().encode(`liaison-push-user:${userId}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function postReceipt(device, notificationId, outcome, reason) {
  if (!device) return
  try {
    const body = {
      notificationId,
      deviceId: device.deviceId,
      surface: "browser_push",
      appState: "background",
      outcome,
    }
    if (reason) body.reason = reason
    const post = () =>
      fetch(device.receiptsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${device.credential}`,
        },
        body: JSON.stringify(body),
      })
    const res = await post()
    // The server records the delivery just after sending, so an instant receipt
    // can read 404: post it once more a moment later.
    if (res && res.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await post()
    }
  } catch {
    // Offline or refused: the delivery row still exists, the receipt is lost.
  }
}

function parseFrame(event) {
  try {
    const frame = event.data ? event.data.json() : null
    return frame && typeof frame === "object" ? frame : {}
  } catch {
    return {}
  }
}

async function handlePush(event) {
  const frame = parseFrame(event)
  const device = await readDevice()
  if (device && typeof frame.userTag === "string") {
    let mine = false
    try {
      mine = (await userTagOf(device.userId)) === frame.userTag
    } catch {
      mine = false
    }
    if (!mine) return
  }
  const title = typeof frame.title === "string" && frame.title ? frame.title : "Liaison"
  // One notification per conversation (`tag`); a replacement still alerts.
  const tag =
    typeof frame.tag === "string" && frame.tag
      ? frame.tag
      : typeof frame.notifyId === "string"
        ? frame.notifyId
        : undefined
  let shown = true
  try {
    await self.registration.showNotification(title, {
      body: typeof frame.body === "string" ? frame.body : "",
      tag,
      ...(tag ? { renotify: true } : {}),
      data: { route: typeof frame.route === "string" ? frame.route : null },
    })
  } catch {
    shown = false
  }
  if (typeof frame.notificationId === "string") {
    await postReceipt(
      device,
      frame.notificationId,
      shown ? "shown" : "suppressed",
      shown ? null : "show_failed",
    )
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event))
})

// LIF-18: a click opens the item the notification is about. The route goes to
// an open Liaison window of THIS origin (focused, then told by message), else
// a new window opens on `/?route=...`; either way the page's one resolver
// (src/modules/notifications/open-route.ts) validates it and ignores anything
// that is not one of its two grammars. The worker only checks it is a string.
const MAX_ROUTE_LENGTH = 512

function sameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin
  } catch {
    return false
  }
}

async function handleNotificationClick(notification) {
  const data = notification && notification.data
  const raw = data && typeof data === "object" ? data.route : null
  const route =
    typeof raw === "string" && raw.length > 0 && raw.length <= MAX_ROUTE_LENGTH ? raw : null
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true })
  const open = windows.find((w) => typeof w.focus === "function" && sameOrigin(w.url))
  if (open) {
    await open.focus()
    if (route && typeof open.postMessage === "function") {
      open.postMessage({ type: "open-route", route })
    }
    return
  }
  return clients.openWindow(route ? `/?route=${encodeURIComponent(route)}` : "/")
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(handleNotificationClick(event.notification))
})
