# AGENTS.md

本文件面向 AI 代理与开发者，系统描述 WebVPN 项目的整体架构、请求生命周期、服务端/客户端双重改写机制、扩展点与注意事项。阅读本文件即可对项目建立完整认知。

---

## 1. 项目概述

WebVPN 是一个运行在主域名上的在线反向代理服务，可在自己的二级域名下**全量代理任何第三方网站**。它不是简单的反代，而是对目标网站的 HTML / CSS / JS / DOM / 网络请求 / 导航进行**深度改写**，使被代理网站在浏览器中表现为“运行在 WebVPN 域名下，但行为等同于原站”。

核心思路：把目标网址的**域名编码为 WebVPN 的子域名**，路径与查询串保持不变作为后缀。例如：

```
https://www.example.com/path/page
        ↓ 编码域名
https://www__example__com.<webvpn主域名>/path/page
```

能力定位（README 自述）：Web 上的 VPN、高级内网穿透工具、可做完美网站镜像（作者明确反对用于钓鱼等违法用途）。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js（ESM, `"type": "module"`） |
| Web 框架 | Koa 2 |
| HTTP 客户端 | node-fetch 3（手动 `redirect: 'manual'`） |
| 原生 HTTP/HTTPS | `node:http` / `node:https`（流式管道 `respondPipe`） |
| WebSocket 代理 | ws（`WebSocketServer` + 客户端 `WebSocket`） |
| 字符集解码 | iconv-lite |
| zstd 解压 | simple-zstd（`ZSTDDecompress`） |
| 多进程 | `node:cluster` |
| 工具库 | `@wp1001/node`（`fsUtils` 文件系统封装）、chalk（彩色日志） |
| 前端拦截 | 纯原生 JS，无框架，基于原型链 Proxy / Object.defineProperty |

> 无构建步骤、无前端打包器。`public/` 下均为直接由服务器吐给浏览器的源文件。

---

## 3. 目录与文件地图

```
.
├── main.js              # 入口示例：继承 WebVPN 类，实例化并 start()
├── webvpn.js            # 核心服务端（WebVPN 类，~1220 行），全部代理逻辑
├── config.js            # 配置示例（域名、端口、模式、开关等）
├── package.json         # 依赖与脚本（push/pull/cloc）
├── ssl/
│   ├── server.key       # SSL 通配符证书私钥
│   └── server.pem       # SSL 通配符证书
├── public/              # 浏览器侧资源（由 /public/ 路径直接提供）
│   ├── index.html       # WebVPN 首页（URL 转换 / 会话共享生成器）
│   ├── intercept.js     # 【关键】前端拦截脚本（~1314 行），注入到每个 HTML
│   ├── plugins.js       # 媒体下载浮窗 + 工具函数（sleep/addStyle/addScript）
│   ├── share-sessions.js# main 会话：上报 cookie + localStorage
│   ├── filesaver.js     # 第三方 FileSaver.js 库（媒体下载用）
│   ├── disable-devtools.js # 第三方 devtools 检测库，禁用开发者工具
├── README.md            # 中英双语说明
├── tech.md              # 开发技术笔记（各类改写要点、坑点速查）
└── cache/               # （运行时生成）静态资源本地缓存目录，已 gitignore
```

---

## 4. 域名编码方案（核心）

### 4.1 两种模式（`config.domainMode`）

构造函数根据 `site.hostname` 派生：
- `vpnDomain` = 主域名去掉 `www`（如 `webvpn.info`）
- `httpVpnDomain` / `httpsVpnDomain` = `vpnDomain` +（端口非标准时附 `:port`）

#### `original` 模式
目标 host 原样作为**多级子域名**拼接：

```
www.example.com  →  www.example.com.<vpnDomain>
```
- `encodeHost`: 直接返回 host（`: ` → `_._`），优先查 `subdomains` 字典
- `decodeHost`: 反向
- **支持 cookie 的 `domain=` 设置**（可逐子域隔离）

#### `underline` 模式（默认）
把 host 压平成**单段子域名**：

```
www.example.com  →  www__example__com.<vpnDomain>
a-b.example.com  →  a_h_b__example__com.<vpnDomain>
localhost:3000   →  localhost_c_3000.<vpnDomain>
```
编码规则：`.` → `__`，`-` → `_h_`，`:` → `_c_`
- **不支持 cookie 的 `domain=` 设置**（见 `initResponseHeaders` 中 set-cookie 处理与注释 `warn warn warn`）

### 4.2 单域名代理（`config.subdomains`）
无法配置泛解析 DNS 时，可固定若干二级域名映射到目标：

```js
subdomains: { 'baidu': 'www.baidu.com', 'im': 'im.qq.com' }
```
`encodeHost` / `decodeHost` 优先查该字典，命中即用短子域名。注意：被代理网站若引用第三方资源，对应第三方域名也需在此登记。

### 4.3 `convertDomainsCode`
服务端把 `encodeHost` / `decodeHost` / 字典 / 模式拼成一段 JS 字符串：
- 服务端 `eval(this.convertDomainsCode)` 自用
- 注入到首页 `index.html`、注入到每个 HTML 的 `<script>`、作为 Worker 上下文前缀

客户端与服务端使用**同一套编解码逻辑**，保证一致性。

---

## 5. 服务端架构（`webvpn.js`）

### 5.1 类结构

`WebVPN` 类持有：配置、MIME 正则表、忽略头正则、各类注入代码片段（`jsInterceptCode` / `convertDomainsCode` / `jsWorkerContextCode` / `jsScopePrefixCode` / `jsScopeSuffixCode`）、全局缓存 `globalCache`。

`main.js` 通过继承覆盖钩子方法来自定义行为（见 §10）。

### 5.2 启动 `start()`

- `numProcesses > 1` 且为主进程 → `cluster.fork()` 多个工作进程；主进程负责**缓存同步**：工作进程 `setItem` 时通过 IPC 通知主进程，主进程再 `syncCache` 广播给其他工作进程。进程退出自动重启。
- 工作进程 / 单进程 → `createApp()` 创建 Koa + HTTP（+可选 HTTPS）+ WebSocketServer。

### 5.3 请求生命周期（`proxyRoute`）

这是整个服务端的中枢，逐请求处理：

```
1. WebSocket 升级？ → handleUpgrade → wsServer.onConnection（双向桥接）
2. 解析 scheme（http/https）、从 Host 剥离 vpnDomain 得到 subdomain
3. subdomain === 'www' → serveWww：
     - '/'         → 返回 index.html（注入 config + convertDomainsCode）
     - '/share-sessions' → 会话共享上报端点（POST 存 cookie+localStorage）
     - 其他 /public/xx → checkPublic 直接返回静态文件
4. subdomain 以 vpnDomain 开头（非法/根域误访问）→ 302 回首页
5. checkPublic（/public/ 路径优先放行）
6. routeInit：
     - checkShareSession（解析 -main-/-share-<shareId>，同步 cookie/authorization）
     - decodeHost(subdomain) → 目标域名
     - 组装 ctx.meta = { shareId, isMainSession, url, isXHR, mime, scheme, target, host, origin, referer }
7. 缓存命中？（config.cache 且 mime 属于 cacheMimes）→ 直接返回缓存文件
8. noTransform mimes（wasm/font/json/image/video/audio/pdf-office/stream/event-stream）
     → respondPipe：原生 http/https 流式管道，不改写
9. request()：node-fetch 发请求，redirect: manual
     - location 头存在 → 直接写 3xx（已改写 location）→ done
     - convertCharsetData：处理 zstd / 非 utf-8 字符集 → utf-8
     - isJsonpResponse / isJsonResponse → 透传
10. afterRequest 钩子（返回真值则短路结束）
11. shouldReplaceUrls && res.data → replaceUrls + customResponse
      - mime === 'html' → processHtml（去 CSP meta）+ processHtmlScopeCodes（包内联脚本）+ appendScript（注入拦截脚本）
      - mime === 'js'   → processJsScopeCode（包作用域）
12. processOthers（json 序列化、disableSourceMap 抹掉 sourceMappingURL）
13. beforeResponse 钩子（返回真值则短路）
14. setCache（按需写本地缓存）
15. ctx.body = res.data 响应
```

### 5.4 MIME 判定

- `getResponseType(ctx, url)`：按 URL 后缀正则判定（`mimeRegs`），PUT/POST 一律 `text`，根路径判 `html`。
- `getMimeByResponseHeaders(headers)`：按响应 `content-type` 二次校正。
- `noTransformMimes`：不进入改写流水线，直接管道透传。
- `cacheMimes`：可被本地磁盘缓存的类型。

### 5.5 响应头改写（`initResponseHeaders`）

| 头 | 处理 |
|---|---|
| `access-control-allow-origin` | 把目标 origin 改写为编码后的 vpn 子域（含会话共享后缀 `-main/-share-<id>`） |
| `content-security-policy` | 剥离 `-src` / `unsafe-` / `require-trusted-types-for`；`frame-ancestors` 改写为允许 WebVPN 主域；https 下追加 `upgrade-insecure-requests` |
| `location` | 相对路径补全为目标 origin，再 `transformUrl` 改写为 vpn 域名 |
| `set-cookie` | 去 `Secure;`；`domain=` 在 original 模式下改写为编码子域，underline 模式下塌缩为 `vpnDomain` |
| `x-frame-options` | 强制 `allowall` |
| 默认 | `access-control-allow-origin: *`（若未指定） |

会话消费者（非 main、有 shareId）：用 `globalCache` 中存的 cookie 覆盖 `set-cookie`。

### 5.6 请求头改写（`setOriginHeaders`）

把浏览器发来的 vpn 域名 Host / Origin / Referer **还原为目标域名**，对目标服务器透明。Referer 若非 vpn 域名则删除。

### 5.7 请求体（`calcRequestBody`）

- 非 multipart：拼成字符串
- multipart/form-data：读成 `Uint8Array`，用 `FormData` + `File` 重新封装（node-fetch 的 File API）

---

## 6. 服务端 JS / HTML 改写机制（关键细节）

目标：让被代理网站的 JS 在“以为自己在原站”的同时，所有 URL / location / 全局对象都被劫持到 vpn 域。

### 6.1 `customResponse`（通用文本预处理）
- `type="module"` → `type="mod"`，`nomodule` → `nomod`（**禁用 ES module 与严格模式**，以支持 `with` 语句）
- `integrity` → `no-integrity`（关闭 SRI 校验，否则改写后的资源哈希不匹配）
- 抹掉 `use strict`
- `with(this)` → `with(this === self ? __self__ : this)`
- `location.hostname|host|origin|href|protocol|...` → `location.__xxx__`（路由到伪造的源站 location）

### 6.2 作用域包裹（`refactorJsScopeCode`）
把每段 JS 代码包成：

```js
(function () {
  with (self.__context_proxy__) {
    <原代码>
  }
}).call(self.__context__.self)
```

并在末尾追加 `calcHoistIdentifiersCode`：扫描代码里的 `function/class` 名，把提升的标识符挂到 `self` 上（`try { self.xxx = xxx } catch {}`），保证 `with` 作用域内能访问到这些声明。

- `processHtmlScopeCodes`：抽取 HTML 中所有内联 `<script>` 内容（排除非 JS type），逐个用上法包裹后回填。
- `processJsScopeCode`：对外部 .js 文件做同样包裹，并在前面补 Worker 上下文代码（`jsWorkerContextCode`）。

### 6.3 Worker 上下文（`jsWorkerContextCode`）
在 Worker 内构造与主页面一致的 `__context__` 环境：
- 绑定 `setTimeout` / `setInterval` / `importScripts`（后者包 `transformUrl`）
- 构造 `__location__`（getter 返回 target 对应属性）
- 构造 `__self__` / `__globalThis__` Proxy（拦截 `location` 等访问）
- 构造 `__context__` + `__context_proxy__`（`has` 永真，`get` 优先 context 否则 fallback self）
- 包装 `fetch`：对入参 URL 做 `transformUrl`

### 6.4 `appendScript`（HTML 头部注入）
在每个 HTML（非 XHR）响应最前面注入一个大 `<script>` 块，建立客户端运行时：
- `self.webvpn = { siteUrl, protocol, sourceUrl, pageUrl, hostname, httpVpnDomain, httpsVpnDomain, base, interceptLog, disableJump, confirmJump, isMainSession, shareId }`
- `eval(convertDomainsCode)`（注入 encodeHost/decodeHost）
- `eval(webvpn.intercept_code)`（注入 `public/intercept.js` 全文）
- 构造 `webvpn.worker_wrapper_code`（供后续 Worker blob 改写用）
- 条件注入：`plugins.js`（enablePlugins）、vConsole（debug 且未禁 devtools）、`disable-devtools.js`（disableDevtools）、`share-sessions.js`（isMainSession）、会话消费者恢复脚本（从 globalCache 取 cookie+localStorage 回填）
- 末尾移除页面上原有 `<script>`（避免重复执行 / 绕过），最终结构为 `<!DOCTYPE html>\n<注入块><原 HTML body>`

---

## 7. 客户端拦截（`public/intercept.js`，~1314 行）

被注入到每个被代理页面（及子 iframe），在浏览器侧完成“运行时改写”。这是项目最庞大、最精密的部分。

### 7.1 运行时模型
- `webvpn` 全局对象：`siteUrl`(vpn 主站)、`sourceUrl`(目标源站 URL)、`pageUrl`(当前 vpn 页面 URL)、`hostname`(目标主机)、`location` / `currentHref` / `target`（getter 动态计算）
- `location` Proxy：访问 `__xxx__`（如 `location.__hostname__`）返回**源站**对应值；访问普通属性在原生值为空时回退到**vpn 页面**值。这是让网站 JS “看到”源站 URL 的核心。

### 7.2 `transformUrl` / `decodeUrl`（客户端版）
与服务端同源逻辑，处理 `mailto:` / `tel:` / `javascript:` / `data:` / `blob:` 等忽略前缀，处理 `//`、相对路径、`http` 嵌入等情况，并附加会话共享后缀。

### 7.3 拦截清单（按类别）

**URL 属性 setter/getter**（`nodeAttrSetters`，逐元素原型重定义）：
- `a[href]`、`img[src][srcset]`、`script[src]`、`link[href]`、`video[src][poster]`、`audio[src]`、`source[src][srcset]`、`iframe[src]`、`form[action]`、`embed[src]`、`object[data][archive][codeBase]`
- getter：`decodeUrl`（把 vpn URL 还原成源站 URL 给网站读）
- setter：`transformUrl`（把网站写的源站 URL 转成 vpn URL）
- `a` 元素的 `host/hostname/origin/port/protocol` 也被重定义，基于 href 动态计算

**DOM 变更方法**（包装原型方法）：
- `appendChild` / `insertBefore` / `replaceChild`（Node）
- `replaceChildren` / `prepend` / `append` / `before` / `after`（Element + DocumentFragment）
- `insertAdjacentHTML` / `insertAdjacentElement`
- `innerHTML` / `outerHTML`（重定义为：解析 HTML → transformNode → 重建子节点；getter 调 `decodeUrlInHtml` 还原）
- `document.write` / `document.writeln`（`transformHtml` 后再写出）
- `setAttribute`（URL 类属性时 transformUrl；带 `'custom'` type 跳过以避免递归）
- `getAttribute`（URL 类属性时 decodeUrl）

**网络请求**：
- `XMLHttpRequest.open`：`transformUrl(url)`
- `fetch`：string / Request 两种入参均处理
- `WebSocket`：构造 + 调用均拦截
- `EventSource`：构造拦截
- `Worker`：`transformUrl`；若是 blob Worker 且内容为字符串，用 `worker_wrapper_code` 包裹后重建 blob
- `ServiceWorkerContainer.register`：`transformUrl`

**导航 / History**：
- `a.click`、`window.open`、`History.go/pushState/replaceState`
- `location.assign/replace/reload/navigate/toString`（挂为 `_xxx` / `__xxx__`）
- `location.href` setter（通过 `__location__` Proxy 拦截）
- 统一经 `canJump(url)`：受 `disableJump` / `confirmJump` 控制

**全局对象伪造**（`redefineGlobals`）：
- 为 `window/document/globalThis/parent/self/top` 各建 `__xxx__` Proxy，组合成 `__context__` 与 `__context_proxy__`（`has` 永真，配合 `with` 语句劫持作用域解析）
- `__location__`：完整重定义 location 各属性（getter 返回 decodeUrl 后的源站值，setter href 时 transformUrl）
- iframe `contentWindow` / `contentDocument`：对子窗口 `redefineGlobals` + 注入 intercept_code（跨域 iframe try/catch 容错）
- `frames`：按 index 访问时对子窗口 redefineGlobals

**其他**：
- `Function` 构造器 Proxy：动态生成代码自动包 `with(__self__.__context__)`，`with(this)` 重写
- `Object.assign`：处理 `__location__` 作为源时展开 getter
- CSS：`style.backgroundImage` / `cssText` 的 `url()` 改写；`<style>` 节点 `url()` / `@import` 改写
- `document.URL` / `document.domain` / `document.baseURI` / `HTMLElement.baseURI` / `document.referrer` 重定义
- `Blob` / `URL.createObjectURL`：记录 blob 内容（供 Worker blob 改写）
- `MutationObserver.observe`：把 `__document__` 还原为 `document`
- `console.createTask` 删除（兼容性问题）
- `document.cookie` 描述符锁为 `configurable: false`（防止部分网站自定义导致冲突）

**兜底**：`load` + 1s/2s/3s 定时器周期性 `replaceNodesUrls`（TreeWalker 遍历全文档改写链接），应对异步渲染。

### 7.3 日志系统
所有拦截操作通过 `console.log` 带 `%c` 样式输出，并被 `groupLogs` 分类归档到 `webvpn.logs`（如 `webvpn.logs.DOM['appendChild']`、`webvpn.logs.AJAX[...]`）。`interceptLog` 控制是否实际打印，`webvpn.logs.query(keyword)` 可检索。**`plugins.js` 的媒体下载浮窗正是靠轮询 `webvpn.logs` 发现新出现的 video/audio src**。

---

## 8. 会话共享（Session Sharing）

允许多人基于同一 `shareId` 共享同一登录会话（“一人开会员多人共用”）。

### 8.1 域名格式
```
<encodedHost>-<main|share>-<shareId>.<vpnDomain>
```
- `main`：会话提供者
- `share`：会话消费者

### 8.2 服务端 `checkShareSession`
- 从 subdomain 解析出 shareId 与是否 main
- 剥离 origin/referer 中的 `-main/-share-<id>` 后缀
- **main**：把请求带来的 `cookie` / `authorization` 存入 `globalCache`（键 `shareId-cookie` / `shareId-authorization`）
- **share**：从 `globalCache` 取 cookie/authorization 覆盖到请求头

### 8.3 客户端
- main 会话页面注入 `share-sessions.js`：延迟 3s 后 POST `{cookie, localStorage}` 到 `/share-sessions?shareId=`
- 服务端 `serveWww` 收到后存入 `globalCache`（键 `shareId-clientCache`）
- share 会话页面在 `appendScript` 时注入恢复脚本：从 globalCache 取 clientCache，回填 `document.cookie` 与 `localStorage`

### 8.4 跨进程
`globalCache` 通过 cluster IPC 同步（见 §5.2），保证多工作进程间会话一致。

---

## 9. WebSocket 代理

`createApp` 中在 HTTP server 上挂 `WebSocketServer`。`onConnection`：
- 从请求头 `host`（经 `convertHost` 还原）+ `origin` 判定协议 + `request.url` 拼出目标 ws/wss URL
- 建立到目标的 `WebSocket` 客户端
- 双向桥接 `message` / `close`

前端 `intercept.js` 拦截 `new WebSocket(url)` 对 url `transformUrl` 后再交给原生。

---

## 10. 扩展点（子类覆盖，`main.js` 示例）

`WebVPN` 类预留钩子，`main.js` 中 `VPN extends WebVPN` 演示覆盖：

| 方法 | 时机 | 返回值约定 |
|---|---|---|
| `beforeRequest(ctx, options)` | 发请求前（fetch 与 pipe 两条路径都会调） | 返回真值则短路（已自行响应） |
| `afterRequest(ctx, res)` | 拿到响应后、改写前 | 返回真值则短路 |
| `customResponse(ctx, res)` | `replaceUrls` 之后，内容级自定义（记得 `super.customResponse` 保留默认预处理） | 无 |
| `beforeResponse(ctx, res)` | 响应前最后钩子 | 返回真值则短路 |
| `shouldReplaceUrls(ctx, res)` | 是否对该响应做 URL 改写 | boolean |
| `initResponseHeaders(ctx, res)` | 响应头初始化（`main.js` 示例：把 `.wasm` 的 content-type 设为 `application/wasm`） | headers 对象 |

要为特定网站做特殊处理，覆盖对应方法即可，无需改动核心。

---

## 11. 缓存

- `config.cache` 开关，`cacheDir`（默认 `cache/`，已 gitignore）
- `cacheMimes`：js/css/font/image/video/audio/pdf-office 可缓存
- `getCache` / `setCache`：按 `<host>/<encodeURIComponent(pathname)>` 存取
- `ctx.meta.cache = false` 可单请求禁用
- 启动时 `checkCaches` 扫描缓存目录索引

---

## 12. 配置参考（`config.js`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `httpsEnabled` | `true` | 是否启用 HTTPS |
| `port` / `httpsPort` | `80` / `443` | HTTP/HTTPS 端口 |
| `site` | `http://www.webvpn.info` | WebVPN 主站 URL（示例，需改成自己的域名） |
| `numProcesses` | `4` | cluster 工作进程数 |
| `cache` | `false` | 本地资源缓存 |
| `cacheDir` | `'cache'` | 缓存目录 |
| `interceptLog` | `false` | 浏览器控制台打印拦截日志 |
| `disableJump` | `false` | 禁止一切跳转 |
| `confirmJump` | `false` | 跳转前 confirm 询问 |
| `disableSourceMap` | `true` | 抹掉 sourceMappingURL |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | 设 0 避免 hostname/IP 证书 altnames 不匹配错误 |
| `enablePlugins` | `true` | 注入 plugins.js（媒体下载等） |
| `debug` | `false` | 注入 vConsole |
| `disableDevtools` | `true` | 禁用浏览器开发者工具 |
| `domainMode` | `'underline'` | 域名编码模式（见 §4.1） |
| `subdomains` | `{baidu, im}` | 单域名代理映射（见 §4.2） |

---

## 13. 运行

```bash
npm install            # 或 yarn install
node main.js
# 访问 http://www.<你的域名>/  （需泛解析 DNS + 通配符 SSL 证书）
```

本地部署可改本地 DNS（dnsmasq 等）或使用 `subdomains` 单域名模式。SSL 证书放 `ssl/server.key` 与 `ssl/server.pem`。

npm 脚本：
- `npm run push` / `npm run pull`：提交 / 拉取
- `npm run cloc`：统计核心文件代码量

---

## 14. 重要注意事项与已知限制

1. **`underline` 模式不支持 cookie `domain=`**：所有 cookie 域被塌缩为 `vpnDomain`，跨子域 cookie 隔离失效。需要严格 cookie 隔离时用 `original` 模式（多级子域名）。
2. **禁用 ES module 与严格模式**：`customResponse` 把 `type="module"` 改成 `type="mod"`、抹掉 `use strict`，因为改写机制依赖 `with` 语句（非严格模式）。依赖原生 ESM 的现代站点可能受影响。
3. **SRI 被关闭**：`integrity` → `no-integrity`，否则改写后的资源子资源完整性校验会失败。
4. **`eval` 不拦截**：`intercept.js` 注释说明 eval 在调用者作用域执行、读不到局部变量，无法可靠拦截。`Function` 构造器已拦截。
5. **CSP 被大幅改写**：`-src` / `unsafe-` / `trusted-types` 相关策略被剥离，`frame-ancestors` 改写为允许 WebVPN 主域。这是改写能生效的前提，但也意味着放宽了原站安全策略。
6. **跨域 iframe**：`contentDocument` 注入用 try/catch 容错；跨域 iframe 无法注入 intercept_code 时，其内部链接改写依赖服务端层面。
7. **字符集**：非 utf-8 页面经 iconv-lite 转为 utf-8 并改写 meta charset；zstd 响应会被解压。
8. **`document.cookie` 描述符锁 `configurable: false`**：防止部分网站自定义 cookie descriptor 引发冲突（代码中标注 TODO）。
9. **多进程缓存**：仅在 `numProcesses > 1` 时通过 IPC 同步；单进程无需。
10. **目标 https 站点**：`httpsAgent` 设 `rejectUnauthorized: false`，对自签/证书不匹配的目标站点也放行（`NODE_TLS_REJECT_UNAUTHORIZED`）。

---

## 15. 开发约定

- 代码与注释以中文为主，技术术语用英文。
- 改服务端逻辑改 `webvpn.js`；改浏览器拦截改 `public/intercept.js`；新增页面级功能优先走 `public/plugins.js`。
- 为特定网站做适配，**优先在 `main.js` 覆盖钩子方法**，不要直接改核心类。
- `tech.md` 是作者的技术笔记，记录了各类改写要点的速查（DOM 拦截、History、视频分段、HLS、koa 多进程等），遇到具体改写问题时可先查该文件。

---

## 16. 依赖清单

| 包 | 用途 |
|---|---|
| `@wp1001/node` | `fsUtils`（listDir / read / write / exists / mkdir） |
| `koa` | Web 框架 |
| `node-fetch` | HTTP 客户端（含 File / FormData） |
| `ws` | WebSocket 服务端 + 客户端 |
| `iconv-lite` | 字符集解码 |
| `simple-zstd` | zstd 流式解压 |
| `chalk` | 终端彩色日志 |
