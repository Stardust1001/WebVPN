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

## Major Update — AST `this` Rewriting

The recently added **AST `this` rewriting** (powered by [oxc](https://github.com/oxc-project/oxc)) solves the long-standing "dynamic `this` penetration" problem in JS scope hijacking. This is the only known general solution — no per-site rules needed.

> ⚠️ **A note on authorship**: The AST feature is newly developed with AI assistance. All prior features (domain encoding, server-side full-chain rewriting, client-side prototype-chain hijacking, session sharing, WebSocket proxy, etc.) are entirely hand-written by the author. The project has been developed intermittently over a long period with limited personal bandwidth. Compatibility has been tested against many real-world websites with very good results.

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

---

*This project is for technical research purposes only. Please ensure it is used within authorized scope and not for any illegal purposes.*
