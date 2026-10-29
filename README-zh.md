# WebVPN

> 在浏览器里实现内网穿透与全量代理：把任意第三方网站完整搬到你的域名下运行。

**[English](./README.md)** · 中文

---



## 简单介绍

WebVPN 可以"完全彻底"地转发和代理任何第三方网站。它不是简单的反代，而是对目标网站的 HTML / CSS / JS / DOM / 网络请求 / 导航进行**深度改写**，让被代理网站在浏览器里表现为"运行在 WebVPN 域名下，但行为等同于原站"。

- **Web 层内网穿透**：零客户端，从任意网络环境访问内网系统，只需一个浏览器
- **全量代理**：HTML / CSS / JS / DOM / fetch / XHR / WebSocket / Worker / Cookie 全链路改写
- **会话共享**：多人可基于共享 ID 复用同一登录会话
- **通用拦截**：不写每站规则——所有 URL 访问在 JS 语言层面被拦截

核心思路：把目标网址的**域名编码为 WebVPN 的子域名**，路径与查询串保持不变。

```
https://www.example.com/path/page
        ↓ 编码域名
https://www__example__com.<webvpn主域名>/path/page
```



## 能做什么

- **远程办公 / 跨网络访问**：在家访问公司内网系统（OA、Jira、GitLab、BI），无需 VPN 客户端
- **完美网站镜像**：被代理站点在你的域名下完整运行
- **会话共享**：一人登录，多人通过共享链接复用会话
- **跨地域访问**：像在同一个局域网里一样访问任意网站



## 安装与运行

```bash
npm install
node main.js
```

访问 [http://www.你的域名.com/](http://www.你的域名.com/)

推荐配置 DNS 泛解析（配合 SSL 通配符证书，即可代理任意网站）；泛解析不方便时，可改用下方的单域名模式，本机调试也可以用 dnsmasq 等工具模拟本地 DNS。



## 说明

WebVPN 可以"完全彻底"地转发和代理任何第三方网站。它不仅是 Web 上的 VPN，还是高级内网穿透工具。也可以用来制作完美的网站镜像。**禁止作为钓鱼用途，所有后果由个人自负。本工具仅用于技术研究，不承担任何责任。**

相信我，WebVPN 名副其实。当你真正使用它时，你会发现它能做很多你从未想过的事情。虽然它还不够完美，但应该具备的基本功能都已经具备了。

如果对你有帮助，可以请我喝一杯奶茶，非常感谢。我为此花了上千个小时，耗费了巨大的精力，把它开源就是为了方便所有需要它的人。



## 单域名代理

如果你不擅长 dnsmasq 等工具，并且只想要代理某几个域名，可以实现！在 `config.js` 配置文件里修改 `subdomains` 即可：

```js
// config.js
{
  subdomains: {
    'baidu': 'www.baidu.com',   // baidu.<你的域名> 指向 www.baidu.com
    'im': 'im.qq.com',          // im.<你的域名>    指向 im.qq.com
    'weixin': 'weixin.qq.com'   // weixin.<你的域名> 指向 weixin.qq.com
  }
}
```



## 联系方式

Email: 2368354416@qq.com



## 感谢

<p>
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/alipay.jpg">
  <img width="200" src="https://raw.githubusercontent.com/Stardust1001/WebVPN/refs/heads/master/wxpay.jpg">
</p>



## 重磅更新 — AST `this` 重写

新增的 **AST `this` 重写**（基于 [oxc](https://github.com/oxc-project/oxc)）解决了 JS 作用域劫持里长期存在的"动态 `this` 穿透"问题。这是目前已知的唯一通用解——不需要给每个网站写规则。

> ⚠️ **关于作者参与度**：AST 这个新功能在开发过程中有 AI 的参与。**前面的所有功能**（域名编码、服务端全链路改写、客户端原型链劫持、会话共享、WebSocket 代理等）都是作者本人完全手写的。项目断断续续历时很久，个人精力有限，但已在很多真实网站上测试过兼容性，效果很不错。



## 项目历程

从 2022 年 9 月的第一个提交到现在，断断续续四年多、480 余次提交（分布在 27 个活跃月份）。以下是 git 历史里的关键节点、踩过的坑和解决思路。

### 起点：第一次提交（2022.09.03）

首次提交就不是 hello world，而是一个 **2716 行的能跑的完整 MVP**：服务端 webvpn.js 978 行（Koa + node-fetch 的路径式代理，`/proxy/all/<编码后的目标地址>` 与 `/proxy/single/` 两种模式，MIME 判定、location 正则改写、拦截脚本注入）；前端 append.js 782 行——今天 intercept.js 的前身，已具备现在拦截体系的雏形：16 类元素 × URL 属性的改写清单（a/img/script/link/video/audio/source/iframe/form/embed/object）、XHR `open`、`fetch`、`window.open`、`pushState` / `replaceState`、`innerHTML` 的 defineProperty 拦截、`transformUrl` / `decodeUrl`、按类型归档可检索的日志系统（今天的 `webvpn.logs`）。另外还自带 550 行手写的 HTML 解析器（htmlparser + html2json，2025 年被浏览器原生 `DOMParser` 取代）和一个中文简繁转换模块。README 的第一句话就是 "fully proxy all websites"——目标从第一天起就没变过。

### 关于时间：提交数远不是全部

480 余次提交、27 个活跃月份，只是**实际投入的下限**。git 历史天然低估了真实耗时：

- **第一次提交前没有仓库**：首提交就带着 2716 行成熟代码，之前的设计与试错完全没有留痕
- **大量提交是"打包"的**：历史里有几百条 "add" / "a little" / "emm..."，每条背后往往是一批改动
- **无提交的月份不等于停止**：2023 年 6、8 月，2024 年大部分时间（全年仅 19 次提交），2026 年 4–8 月——这些空窗多是在真实网站上使用、测试、攒问题，攒够了回来集中爆发（2025 年 134 次提交就是 2024 年沉淀后的总爆发）

所以项目的真实跨度比提交记录显示的更长：实际动工比 2022 年 9 月的首次提交还要早约半年（2022 年初就开始设计与写码，首提交只是把已经成熟的成果入库），从 2022 年初到 2026 年 10 月接近五年，上千小时量级的持续投入。

### 2022.09–11：从"翻转网址"到子域名
- 起步做的是最朴素的 URL 替换：链接字符转义、`mailto:` / `sms:` 忽略、CSS `url()` 与 `@import` 转换
- 最初尝试"翻转网址"方案，很快发现覆盖不了相对路径与 JS 动态生成的链接，一个月后改为**把域名编码为子域名**，架构就此定型
- 开始正面硬刚 location：`window.location.xxx` / `document.location` / `parent.location` / 赋值表达式里的 location……一遍遍补漏，连 `location=no`（滚动条属性）都误伤过

### 2022.10–2023.01：作用域劫持的两代方案
- 第一代是**自定义作用域**：正则找大括号包代码块、替换标识符——大括号检测、注释/字符串范围过滤修了几十次仍然漏
- 2023 年 1 月换成 **`with (__context_proxy__)` 劫持作用域**：`has` 陷阱永远返回 true，代码里所有自由变量都先问代理。这是项目最重要的架构决定，沿用至今
- 代价：`with` 要求非严格模式，所以禁用 ESM（`type=module` → `mod`）与 `use strict`

### 2023：全链路补完
- 4 月支持 HTTPS（commit 原话："!!! wow ! supports https !!!"）；同月发现丢掉 `<!DOCTYPE html>` 会引发用户代理样式异常
- 最难的 bug 是**动态 this 穿透**：`with` 里调用的函数 `this` 指向不对。最终用 `with(this === self ? __self__ : this)` 加事件绑定 this 拦截解决
- `function` / `class` 声明提升到 `self`（calcHoistIdentifiers），否则 `with` 作用域里看不到
- 转义字符地狱：`&amp;`、`&#x***;`、无分号的 `&nbsp`、innerHTML 转义文本……修了一整月
- 媒体下载插件：探测 video/audio、导出 mp3/mp4，试过 ffmpeg 合流后放弃

### 2024–2025：深水区
- `Function` 构造器 Proxy 拦截动态生成的代码；`eval` 因为读不到调用者局部变量**无法拦截**，如实放弃
- 会话共享：一人登录、多人凭共享 ID 复用（commit 原话："share login, nice!"）
- zstd 解压、SSE、WebSocket 代理、blob Worker 改写、跨域 iframe contentDocument 注入、`subdomains` 单域名模式（降低泛解析部署门槛）
- 用浏览器原生 `DOMParser` 替换自写的 HTML 解析

### 2026：Rust 重写与 AST
- 9 月开始用 Rust 重写服务端（axum + tokio + reqwest），功能与 Node 版对齐
- 10 月落地 **AST `this` 重写**（基于 oxc）：精准改写 `this` 与 7 个作用域标识符，保留 ESM/严格模式；浏览器端经 `rewrite.wasm` 改写 eval/Function。这是目前已知的"动态 this 穿透"唯一通用解

### 一些"认输"的记录
诚实的失败也是历程的一部分：eval 无法可靠拦截；underline 模式下 cookie 的 `domain=` 无法逐子域隔离；静态分析改不了 `import` 关键词，只能靠运行时 fetch 拦截兜底。



## Rust 版本

`rust/` 目录提供了服务端的 Rust 重写版本，功能与 Node.js 版对齐：域名编码（original / underline 模式、单域名代理）、服务端全链路改写（复用 `public/intercept.js`）、会话共享、WebSocket 代理、本地缓存、非 UTF-8 字符集与 zstd 解压、上游超时等。技术栈为 axum + tokio + reqwest（rustls TLS）；AST `this` 重写基于 oxc（`rewrite_this = true` 时启用，用 `rust/build-wasm.sh` 构建 `public/rewrite.wasm`，供浏览器端改写 eval/Function）。配置见 `rust/config.toml`，与 Node 版的 `config.js` 相互独立、互不影响。

```bash
cd rust && cargo run --release
```

> ⚠️ **Rust 版本由 AI 完整实现**：受个人精力所限，服务端的 Rust 重写交由 AI 完成（Node.js 版仍为作者手写），并已在真实网站上持续测试改进。

---

*本项目仅用于学习研究，请确保在授权范围内使用，勿用于违反法律法规的用途。*
