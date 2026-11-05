// SPDX-License-Identifier: FSL-1.1-ALv2
// The pure parts of the setup helpers: what the website crawler fetches and
// how it names and cleans pages, and what the repository collector copies.
import { describe, expect, test } from "bun:test"
import { byImportance, isDocPath, secretKind } from "~/cli/setup/collect-repo-docs"
import {
  assertPublicHost,
  decodeCfEmail,
  extractLinks,
  extractSitemapLocs,
  type FetchPolicy,
  fetchSitePage,
  fileNameFor,
  htmlToMarkdown,
  isAllowed,
  isPrivateAddress,
  MAX_RESPONSE_BYTES,
  normalizeLink,
  pageTitle,
  parseRobots,
  readCapped,
  sitemapUrls,
} from "~/cli/setup/crawl-site"

describe("crawl-site", () => {
  test("robots.txt: the * group's rules and every sitemap; longest rule wins", () => {
    const rules = parseRobots(
      "User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/press\nSitemap: https://acme.example/sitemap.xml\n",
    )
    expect(rules.sitemaps).toEqual(["https://acme.example/sitemap.xml"])
    expect(isAllowed(rules, "/pricing")).toBe(true)
    expect(isAllowed(rules, "/private/hr")).toBe(false)
    expect(isAllowed(rules, "/private/press/kit")).toBe(true)
  })

  test("links: same host only (www or not), no fragments, trackers, mailto or Cloudflare paths", () => {
    const base = new URL("https://www.acme.example/docs/")
    expect(normalizeLink("/pricing?utm_source=x#plans", base)?.toString()).toBe(
      "https://www.acme.example/pricing",
    )
    expect(normalizeLink("https://acme.example/about", base)?.toString()).toBe(
      "https://acme.example/about",
    )
    expect(normalizeLink("index.html", base)?.toString()).toBe("https://www.acme.example/docs/")
    expect(normalizeLink("https://other.example/", base)).toBeNull()
    expect(normalizeLink("mailto:a@acme.example", base)).toBeNull()
    expect(normalizeLink("/cdn-cgi/l/email-protection#ab", base)).toBeNull()
    expect(
      extractLinks(
        '<a href="/a">A</a><a class="x" href=\'b.html\'>B</a><a href="#top">T</a>',
        base,
      ).map((u) => u.pathname),
    ).toEqual(["/a", "/docs/b.html"])
  })

  test("sitemaps, titles and file names", () => {
    expect(
      extractSitemapLocs(
        "<urlset><url><loc> https://a.example/x?a=1&amp;b=2 </loc></url></urlset>",
      ),
    ).toEqual(["https://a.example/x?a=1&b=2"])
    expect(pageTitle("<title>Acme | Home</title><h1>Welcome <em>home</em></h1>")).toBe(
      "Welcome home",
    )
    // Entities decode once: an escaped entity stays an entity, as text.
    expect(pageTitle("<title>A &amp;lt;b&amp;gt; &amp; B &#39;C&#39;</title>")).toBe(
      "A &lt;b&gt; & B 'C'",
    )
    expect(fileNameFor(new URL("https://a.example/"))).toBe("index.md")
    expect(fileNameFor(new URL("https://a.example/Docs/Getting-Started/"))).toBe(
      "docs-getting-started.md",
    )
    expect(fileNameFor(new URL("https://a.example/legal.html"))).toBe("legal.md")
  })

  test("main content only, navigation dropped, obfuscated emails restored", () => {
    expect(decodeCfEmail("zz")).toBeNull()
    const key = 0x42
    const hex = [key, ..."hi@acme.example".split("").map((c) => c.charCodeAt(0) ^ key)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
    expect(decodeCfEmail(hex)).toBe("hi@acme.example")
    const md = htmlToMarkdown(
      `<body><nav>Menu</nav><main><h1>Pricing</h1><p>From 10 EUR.</p>
       <a href="/cdn-cgi/l/email-protection#${hex}">[email&#160;protected]</a></main>
       <footer>Footer</footer></body>`,
    )
    expect(md).toContain("# Pricing")
    expect(md).toContain("From 10 EUR.")
    expect(md).toContain("hi@acme.example")
    expect(md).not.toContain("Menu")
    expect(md).not.toContain("Footer")
  })
})

describe("crawl-site network safety", () => {
  const publicResolver = async () => ["93.184.216.34"]
  const site = new URL("https://acme.example/")

  /** A fake web: path or full URL -> response. */
  function fakeWeb(routes: Record<string, () => Response>) {
    const requested: string[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      requested.push(url)
      expect(init.redirect).toBe("manual")
      const route = routes[url]
      return route ? route() : new Response("missing", { status: 404 })
    }
    return { fetchImpl, requested }
  }

  test("private, loopback, link-local and unique-local addresses are recognized", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "172.32.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })

  test("a host resolving to a private address, or localhost, is refused", async () => {
    await expect(assertPublicHost(site, async () => ["10.0.0.5"])).rejects.toThrow(/private/)
    await expect(assertPublicHost(new URL("http://localhost:3000/"))).rejects.toThrow()
    await expect(assertPublicHost(new URL("http://169.254.169.254/"))).rejects.toThrow()
    await expect(assertPublicHost(site, publicResolver)).resolves.toBeUndefined()
  })

  test("redirects are followed by hand and must stay on the site", async () => {
    const { fetchImpl, requested } = fakeWeb({
      "https://acme.example/old": () =>
        new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://acme.example/new": () =>
        new Response("<p>new</p>", { headers: { "content-type": "text/html" } }),
      "https://acme.example/away": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    })
    const policy: FetchPolicy = {
      site,
      allowPrivateNetwork: false,
      fetchImpl,
      resolver: publicResolver,
    }
    const ok = await fetchSitePage("https://acme.example/old", policy)
    expect(ok?.url).toBe("https://acme.example/new")
    expect(ok?.body).toBe("<p>new</p>")

    const refusals: string[] = []
    expect(
      await fetchSitePage("https://acme.example/away", policy, (_u, reason) =>
        refusals.push(reason),
      ),
    ).toBeNull()
    expect(refusals).toEqual(["leaves the site"])
    expect(requested).not.toContain("https://evil.example/x")
  })

  test("a redirect onto a private address is refused unless the intranet opt-in is given", async () => {
    const { fetchImpl } = fakeWeb({
      "https://acme.example/meta": () =>
        new Response(null, { status: 302, headers: { location: "https://www.acme.example/x" } }),
      "https://www.acme.example/x": () => new Response("internal"),
    })
    const resolver = async (host: string) =>
      host === "www.acme.example" ? ["10.0.0.9"] : ["93.184.216.34"]
    expect(
      await fetchSitePage("https://acme.example/meta", {
        site,
        allowPrivateNetwork: false,
        fetchImpl,
        resolver,
      }),
    ).toBeNull()
    expect(
      (
        await fetchSitePage("https://acme.example/meta", {
          site,
          allowPrivateNetwork: true,
          fetchImpl,
          resolver,
        })
      )?.body,
    ).toBe("internal")
  })

  test("a response over the size cap is not read", async () => {
    const big = new Response("x".repeat(10), {
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    })
    expect(await readCapped(big)).toBeNull()
    const streamed = new Response("y".repeat(2048))
    expect(await readCapped(streamed, 1024)).toBeNull()
    expect(await readCapped(new Response("small"), 1024)).toBe("small")
  })

  test("sitemaps and sitemap indexes only ever yield the site's own URLs", async () => {
    const { fetchImpl, requested } = fakeWeb({
      "https://acme.example/sitemap-index.xml": () =>
        new Response(
          "<sitemapindex><sitemap><loc>https://acme.example/pages.xml</loc></sitemap>" +
            "<sitemap><loc>https://evil.example/s.xml</loc></sitemap></sitemapindex>",
        ),
      "https://acme.example/pages.xml": () =>
        new Response(
          "<urlset><url><loc>https://acme.example/a</loc></url>" +
            "<url><loc>http://169.254.169.254/latest</loc></url></urlset>",
        ),
    })
    const robots = parseRobots(
      "Sitemap: https://evil.example/sitemap.xml\nSitemap: https://acme.example/sitemap-index.xml\n",
    )
    const urls = await sitemapUrls(robots, 10, {
      site,
      allowPrivateNetwork: false,
      fetchImpl,
      resolver: publicResolver,
    })
    expect(urls).toEqual(["https://acme.example/a"])
    expect(requested.every((u) => u.startsWith("https://acme.example/"))).toBe(true)
  })
})

describe("collect-repo-docs", () => {
  test("keeps documentation, never code trees, dot files, agent instructions or keys", () => {
    for (const keep of [
      "README.md",
      "LICENSE",
      "CHANGELOG",
      "docs/install.md",
      "docs/guide/setup.rst",
      "packages/sdk/README.md",
      "src/api/README.md",
    ]) {
      expect(isDocPath(keep)).toBe(true)
    }
    for (const drop of [
      "src/index.ts",
      "src/notes.md",
      "node_modules/x/README.md",
      "vendor/lib/README.md",
      ".github/CONTRIBUTING.md",
      ".env.md",
      "CLAUDE.md",
      "AGENTS.md",
      "docs/cert.pem",
      "scripts/templates/app/README.md",
    ]) {
      expect(isDocPath(drop)).toBe(false)
    }
  })

  test("a file holding a credential is recognized", () => {
    expect(secretKind(`token: ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`)).toBe(
      "GitHub token",
    )
    expect(secretKind("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("private key")
    expect(secretKind("SENDGRID=SG.abcdefghijklmnopqr.stuvwxyzABCDEFGHIJ")).toBe("SendGrid key")
    expect(
      secretKind("//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("npm token")
    expect(
      secretKind(
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe("JSON web token")
    expect(secretKind("DATABASE_URL=postgres://app:S3cr3tPassw0rd@db.internal:5432/app")).toBe(
      "credentials in a URL",
    )
    expect(secretKind("password = hunter22x")).toBe("password or secret value")
    expect(secretKind("client_secret: 9fJ2kLq8ZpX4vN7wR1tY6uB3")).toBe(
      "high-entropy credential value",
    )
  })

  test("documentation placeholders are not secrets", () => {
    for (const text of [
      "Set ANTHROPIC_API_KEY in your environment.",
      "postgres://user:pass@host:5432/db",
      "postgres://liaison_readonly:***@postgres:5432",
      // An env reference, as a config documents a password ("$" + "{VAR}").
      "password: $" + "{LIAISON_ADMIN_PASSWORD}",
      "apiKey: <your key>",
      "secret: changeme",
      "token=xxxxxxxxxxxx",
    ]) {
      expect(secretKind(text)).toBeNull()
    }
  })

  test("root files and docs/ come first under a cap", () => {
    expect(["a/b/README.md", "guide.md", "docs/x.md", "README.md"].sort(byImportance)).toEqual([
      "README.md",
      "guide.md",
      "docs/x.md",
      "a/b/README.md",
    ])
  })
})
