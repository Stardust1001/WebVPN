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

## 重磅更新 — AST `this` 重写

新增的 **AST `this` 重写**（基于 [oxc](https://github.com/oxc-project/oxc)）解决了 JS 作用域劫持里长期存在的"动态 `this` 穿透"问题。这是目前已知的唯一通用解——不需要给每个网站写规则。

> ⚠️ **关于作者参与度**：AST 这个新功能在开发过程中有 AI 的参与。**前面的所有功能**（域名编码、服务端全链路改写、客户端原型链劫持、会话共享、WebSocket 代理等）都是作者本人完全手写的。项目断断续续历时很久，个人精力有限，但已在很多真实网站上测试过兼容性，效果很不错。

## 安装与运行

```bash
npm install
node main.js
```

访问 [http://www.你的域名.com/](http://www.你的域名.com/)

DNS 泛解析是需要的，所以请务必使用 SSL 通配符证书。本机部署可自行修改本地 DNS（dnsmasq 等工具），或使用下方的单域名模式。

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

---

*本项目仅用于学习研究，请确保在授权范围内使用，勿用于违反法律法规的用途。*
