import WebVPN from './webvpn.js'
import config from './config.js'

// main.js 是个示例，如果要创建一个 WebVPN 服务，需要继承并实例化 WebVPN 类
// 有些网站需要特殊处理，那么可以覆盖父类的某个方法，加上自定义的实现，来自定义处理

class VPN extends WebVPN {
  // 发送请求之前
  async beforeRequest (ctx, options) {

  }

  // 获取请求之后
  async afterRequest (ctx, res) {

  }

  // 返回响应之前
  async beforeResponse (ctx, res) {
    super.beforeResponse(ctx, res)
  }

  // 是否要替换这个 res 响应里的链接
  shouldReplaceUrls (ctx, res) {
    return true
  }
}

// 实例化
const vpn = new VPN(config)

// 启动 WebVPN 服务
vpn.start()
