// 下面都可以改，这是我自己做的示例

export default {
  // WebVPN 域名是否支持 https
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
  // 是否在浏览器控制台打印拦截操作的日志
  interceptLog: false,
  // 是否禁止跳转
  disableJump: false,
  // 是否在页面跳转前询问用户，由用户决定是否允许网页跳转
  confirmJump: false,
  // 是否禁用 source map
  disableSourceMap: true,
  // 这个设置 0，可有效避免 Hostname/IP does not match certificate's altnames 错误
  NODE_TLS_REJECT_UNAUTHORIZED: 0,
  // 是否开启调试（当前是VConsole）
  debug: false,
  // 是否启用插件
  pluginsEanbled: true,
  // 无法使用泛解析情况下，可使用单个二级域名代理指定网站
  // 但请注意，有些网站会引用第三方网站的资源，那么第三方网站你也要代理
  subdomains: {
    'baidu': 'www.baidu.com',
    'im': 'im.qq.com'
  }
}
