// 下面都可以改，这是我自己做的示例

export default {
  // 域名是否支持 https
  httpsEnabled: true,
  // WebVPN 服务端口
  port: 80,
  // WebVPN https 服务端口
  httpsPort: 443,
  // WebVPN 服务网址，访问其他网站，都从这个网址进行转换
  site: new URL('http://www.webvpn.info'),
  // cluster 模式用几个进程（为了充分利用CPU核心数）
  numProcesses: 4,
  // 是否启用缓存，会把静态资源缓存到本地文件夹以加速后续的网站访问
  cache: false,
  // 缓存文件夹地址
  cacheDir: 'cache',
  // 会话共享持久化目录（share sessions 的 cookie/authorization/clientCache 落盘于此）
  // 多进程下用「写临时文件 → rename」原子替换，无需文件锁；重启不丢会话
  sessionsDir: 'sessions',
  // public 资源文件夹地址
  publicDir: 'public',
  // SSL 证书文件夹地址
  sslDir: 'ssl',
  // 是否把 intercept.js 内部 log 日志输出到浏览器控制台（默认关闭，避免污染目标网站的 console）
  debugLog: false,
  // 是否禁止跳转
  disableJump: false,
  // 是否在页面跳转前询问用户，由用户决定是否允许网页跳转
  confirmJump: false,
  // 是否禁用 source map
  disableSourceMap: true,
  // 是否启用插件
  enablePlugins: true,
  // 是否开启调试（当前是VConsole）
  debug: false,
  // 是否禁用 devtools
  disableDevtools: false,
  // AST 改写模式（原名 rewriteThis，已改名 astRewrite——它控制的早已不只是 this 改写，
  // 而是整套服务端 JS 改写架构的选择）：
  // false = 旧模式（默认）：customResponse 用字符串硬替换（type="module"→"mod"、
  //         抹 use strict、正则 location.xxx→location.__xxx__、正则 with(this)），
  //         refactorJsScopeCode 对每段 JS 包裹 with(__context_proxy__) + hoisting；
  //         浏览器端不加载 rewrite.wasm，运行时动态注入的 module script 转 type="mod"
  // true  = AST 模式：customResponse 用 acorn 解析整份响应，精准改写 this 与
  //         7 个作用域标识符（location/window/self/globalThis/document/parent/top）
  //         及 eval 别名调用；refactorJsScopeCode 不包裹 with；保留 ESM/use strict；
  //         浏览器端同步加载 public/rewrite.wasm 改写 eval/Function/定时器字符串代码
  astRewrite: false,
  // 域名编码模式，original (域名原名直接作为多级子域名) | underline（域名原名去除 . :）
  domainMode: 'underline', // underline 不支持 cookie 的 domain 设置 ！！！！！！
  // 无法使用泛解析情况下，可使用单个二级域名代理指定网站
  // 但请注意，有些网站会引用第三方网站的资源，那么第三方网站你也要代理
  subdomains: {
    'baidu': 'www.baidu.com',
    'im': 'im.qq.com'
  }
}
