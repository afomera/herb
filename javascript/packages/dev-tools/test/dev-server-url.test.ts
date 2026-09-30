import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { HerbClient } from "../src/dev-server/client"

const opened: string[] = []

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(url: string) {
    opened.push(url)
  }

  close(): void {}
  send(): void {}
}

function connectedURL(client: HerbClient): string | undefined {
  client.connect()
  client.disconnect()

  return opened.at(-1)
}

beforeEach(() => {
  opened.length = 0
  document.head.innerHTML = ""
  vi.stubGlobal("WebSocket", FakeWebSocket)
})

afterEach(() => {
  document.head.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("the dev server URL", () => {
  test("defaults to ws://localhost on the default port", () => {
    expect(connectedURL(new HerbClient())).toBe("ws://localhost:8592")
  })

  test("builds ws://host:port from the host and port options", () => {
    expect(connectedURL(new HerbClient({ host: "127.0.0.1", port: 4000 }))).toBe("ws://127.0.0.1:4000")
  })

  test("takes a full URL from the url option, for a dev server behind a TLS proxy", () => {
    expect(connectedURL(new HerbClient({ url: "wss://herb.test", port: 4000 }))).toBe("wss://herb.test")
  })

  test("takes a full URL from the herb-dev-server-url meta tag", () => {
    document.head.innerHTML = '<meta name="herb-dev-server-url" content="wss://herb.test">'

    expect(connectedURL(new HerbClient())).toBe("wss://herb.test")
  })

  test("prefers the url option over the meta tag", () => {
    document.head.innerHTML = '<meta name="herb-dev-server-url" content="wss://herb.test">'

    expect(connectedURL(new HerbClient({ url: "wss://other.test" }))).toBe("wss://other.test")
  })

  test("ignores an empty meta tag", () => {
    document.head.innerHTML = '<meta name="herb-dev-server-url" content=" ">'

    expect(connectedURL(new HerbClient())).toBe("ws://localhost:8592")
  })
})
