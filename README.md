# WebVPN

> A web-based intranet penetration & full proxy: run any third-party website fully under your own domain.

English · **[中文](./README-zh.md)**

---

## Brief

WebVPN is a deep-rewriting reverse proxy that runs on your primary domain and **fully proxies any third-party website**. It is not a simple reverse proxy — it deeply rewrites the target site's HTML / CSS / JS / DOM / network requests / navigation so the proxied site behaves exactly like the original, but runs under your WebVPN domain.

- **Web-based intranet penetration**: zero-client access to intranet systems from any network, just a browser
- **Full proxy**: HTML / CSS / JS / DOM / fetch / XHR / WebSocket / Worker / Cookie full-chain rewriting
- **Session sharing**: multiple people can share one login session via a shared ID
- **Universal interception**: no per-site rules — all URL access is intercepted at the JS language level

The core idea: encode the target domain as a subdomain of WebVPN.

```
https://www.example.com/path/page
        ↓ encode domain
https://www__example__com.<webvpn-domain>/path/page
```

## What it can do

- **Remote office / cross-network access**: access intranet systems (OA, Jira, GitLab, BI) from home, no VPN client needed
- **Perfect website mirror**: the proxied site runs fully functional under your domain
- **Session sharing**: one person logs in, others reuse the session via a shared link
- **Cross-geo access**: access region-locked content as if in the same LAN

## Install & Run

```bash
npm install
node main.js
```

Visit [http://www.your_domain.com/](http://www.your_domain.com/)

DNS pan-resolution is required, so please use an SSL wildcard certificate. For local deployment, modify local DNS (dnsmasq, etc.) or use the single-domain mode below.

## Description

WebVPN can "completely and thoroughly" forward and proxy any third-party website. It is not only a VPN on the Web, but also an advanced intranet penetration tool. It can also be used to make a perfect mirror of any website. **Phishing use is strictly prohibited; all consequences are the sole responsibility of the individual. This tool is for technical research purposes only and assumes no liability.**

Believe me, WebVPN lives up to its name. When you actually use it, you'll find it can do many things you never thought of. It's not perfect yet, but the core capabilities are all there.

If it helps you, you can buy me a cup of milk tea. Thank you very much — I spent thousands of hours and a lot of energy on this. I open-sourced it to help everyone who needs it.

## Single-Domain Proxy

If you don't want to deal with dnsmasq / pan-DNS and only need to proxy a few domains, you can use the `subdomains` config:

```js
// config.js
{
  subdomains: {
    'baidu': 'www.baidu.com',   // baidu.<your-domain> → www.baidu.com
    'im': 'im.qq.com',          // im.<your-domain>    → im.qq.com
    'weixin': 'weixin.qq.com'   // weixin.<your-domain> → weixin.qq.com
  }
}
```

## Contact

Email: 2368354416@qq.com

## Thank you

<p>
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/alipay.jpg">
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/wxpay.jpg">
</p>

## Major Update — AST `this` Rewriting

The recently added **AST `this` rewriting** (powered by [oxc](https://github.com/oxc-project/oxc)) solves the long-standing "dynamic `this` penetration" problem in JS scope hijacking. This is the only known general solution — no per-site rules needed.

> ⚠️ **A note on authorship**: The AST feature is newly developed with AI assistance. All prior features (domain encoding, server-side full-chain rewriting, client-side prototype-chain hijacking, session sharing, WebSocket proxy, etc.) are entirely hand-written by the author. The project has been developed intermittently over a long period with limited personal bandwidth. Compatibility has been tested against many real-world websites with very good results.

## Project History

From the first commit in September 2022 to now: four-plus intermittent years, 480+ commits across 27 active months. Below are the key milestones from the git history, the pitfalls hit, how they were solved, and the ideas behind them.

### The starting point: the first commit (2022.09.03)

The very first commit was no hello world — it was a **working 2,716-line MVP**: a 978-line server (webvpn.js, Koa + node-fetch path-based proxy with two modes — `/proxy/all/<encoded-target>` and `/proxy/single/` — MIME detection, regex-based location rewriting, injected interception script) and a 782-line client script (append.js, the ancestor of today's intercept.js) that already had the blueprint of the current interception system: a rewrite list of 16 element types × URL attributes (a/img/script/link/video/audio/source/iframe/form/embed/object), XHR `open`, `fetch`, `window.open`, `pushState` / `replaceState`, `innerHTML` via defineProperty, `transformUrl` / `decodeUrl`, and a categorized, searchable log system (today's `webvpn.logs`). It also shipped a 550-line hand-written HTML parser (htmlparser + html2json, replaced by the browser-native `DOMParser` in 2025) and a Simplified/Traditional Chinese converter. The README's first line was "fully proxy all websites" — the goal never changed from day one.

### On time: commits are the floor, not the total

480+ commits across 27 active months are only a **lower bound** of the actual effort. Git history inherently undercounts:

- **There was no repo before the first commit**: it arrived with 2,716 lines of mature code — all prior design and trial-and-error left no trace
- **Many commits are bundles**: hundreds of "add" / "a little" / "emm..." entries, each usually hiding a batch of changes
- **Empty months are not idle months**: June/August 2023, most of 2024 (only 19 commits all year), April–August 2026 — those gaps were spent using and testing the tool on real websites, accumulating issues that later erupted in bursts (the 134 commits of 2025 were the blowout after 2024's quiet accumulation)

So the true span is longer than the commit log suggests: work actually began about half a year before the first commit (design and coding started in early 2022; the first commit merely checked in the already-mature result). From early 2022 to October 2026 is nearly five years, on the order of a thousand hours of sustained work.

### 2022.09–11: From "flipped URLs" to subdomains
- Started with plain URL rewriting: character escaping, ignoring `mailto:` / `sms:`, CSS `url()` and `@import` conversion
- The first scheme was "flipping" URLs; it quickly failed on relative paths and JS-generated links, so a month later the architecture switched to **encoding target domains as subdomains** — unchanged since
- Then came the long war on location: `window.location.xxx`, `document.location`, `parent.location`, location inside assignment expressions… patched over and over (even `location=no`, a scroll-bar property, got falsely rewritten once)

### 2022.10–2023.01: Two generations of scope hijacking
- Generation one was a **custom scope**: regex-matched braces to wrap code blocks and rename identifiers — dozens of fixes to brace detection and comment/string range filtering, still leaky
- January 2023 switched to **`with (__context_proxy__)` scope hijacking**: the `has` trap always returns true, so every free variable consults the proxy first. This was the project's most important architectural decision, still in use today
- The cost: `with` requires non-strict mode, hence ESM disabled (`type=module` → `mod`) and `use strict` stripped

### 2023: Completing the full chain
- April: HTTPS support (commit message: "!!! wow ! supports https !!!"); same month, discovered that dropping `<!DOCTYPE html>` triggers user-agent stylesheet quirks
- The hardest bug was **dynamic `this` penetration**: functions called inside `with` got the wrong `this`. Solved with `with(this === self ? __self__ : this)` plus intercepting event-bound `this`
- `function` / `class` declarations hoisted onto `self` (calcHoistIdentifiers), otherwise invisible inside the `with` scope
- Escape-character hell: `&amp;`, `&#x***;`, semicolon-less `&nbsp`, innerHTML-escaped text… a full month of fixes
- Media download plugin: detecting video/audio, exporting mp3/mp4; tried ffmpeg merging, then gave it up

### 2024–2025: The deep water
- `Function` constructor proxied to intercept dynamically generated code; `eval` **cannot** be intercepted (it can't see the caller's local variables) — honestly given up
- Session sharing: one person logs in, many reuse via a shared ID (commit: "share login, nice!")
- zstd decompression, SSE, WebSocket proxy, blob Worker rewriting, cross-origin iframe contentDocument injection, and the `subdomains` single-domain mode (no pan-DNS needed)
- Replaced the hand-written HTML parser with the browser-native `DOMParser`

### 2026: Rust rewrite and AST
- September: server-side rewrite in Rust began (axum + tokio + reqwest), feature parity with the Node version
- October: **AST `this` rewriting** landed (powered by oxc): precise rewriting of `this` and 7 scope identifiers while keeping ESM/strict mode; browser-side eval/Function rewritten via `rewrite.wasm`. This is the only known general solution to dynamic `this` penetration

### Some honest surrender notes
Honest failures are part of the history too: eval can't be reliably intercepted; in underline mode cookies can't be isolated per subdomain via `domain=`; static analysis can't rewrite the `import` keyword, so runtime fetch interception is the fallback.

## Rust Version

A server-side rewrite in Rust lives under `rust/`, with feature parity to the Node.js version: domain encoding (original / underline modes, single-domain proxy), server-side full-chain rewriting (reusing `public/intercept.js`), session sharing, WebSocket proxy, local caching, non-UTF-8 charset decoding, zstd decompression, upstream timeouts, etc. Built on axum + tokio + reqwest (rustls TLS); the AST `this` rewriting is powered by oxc (enabled with `rewrite_this = true`; build `public/rewrite.wasm` via `rust/build-wasm.sh` for browser-side eval/Function rewriting). Configuration lives in `rust/config.toml`, fully independent of the Node version's `config.js`.

```bash
cd rust && cargo run --release
```

> ⚠️ **The Rust version was implemented entirely by AI**: with limited personal bandwidth, the server-side Rust rewrite was done by AI (the Node.js version remains hand-written by the author) and is continuously being tested and improved against real-world websites.

---

*This project is for technical research purposes only. Please ensure it is used within authorized scope and not for any illegal purposes.*

