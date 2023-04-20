import HttpProxyAgent from 'http-proxy-agent'

import WebVPN from './webvpn.js'

// main.js 是个示例，如果要创建一个 WebVPN 服务，需要继承并实例化 WebVPN 类
// 有些网站需要特殊处理，那么可以覆盖父类的某个方法，加上自定义的实现，来自定义处理

class VPN extends WebVPN {
	constructor (config) {
		super(config)
	}

	getDomainProtocol (domain) {
		if (this.config.https) {
			return this.config.site.protocol
		}
		const isIp = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(domain)
		// 若 WebVPN 域名不支持 https，那么就只有 http 服务
		// 那么来的请求，不知其目标网址是 http 还是 https
		// 则，ip 算 http，域名算 https
		// 小问题是：目标网站只支持 http 的话，则无法访问，但可以在这里以白名单形式，控制返回值 http
		return isIp ? 'http:' : 'https:'
	}

	// 发送请求之前
	async beforeRequest (ctx, options) {
		// options.agent = new HttpProxyAgent({
		// 	protocol: 'http:',
		// 	// host: '211.83.244.26',
		// 	// port: '10005',
		// 	host: '111.40.62.176',
		// 	port: '9091',
		// 	rejectUnauthorized: false
		// })
	}

	// 获取请求之后
	afterRequest (ctx, res) {

	}

	// 返回响应之前
	async beforeResponse (ctx, res) {
		// 禁用 module 和严格模式，以支持 with 语句
		if (typeof res.data === 'string') {
			res.data = res.data.replaceAll('type="module"', 'type="mod"')
								.replaceAll('type=module', 'type=mod')
								.replaceAll('nomodule', 'nomod')
								.replaceAll('use strict', '')
		}
	}

	// 是否要替换这个 res 响应里的链接
	shouldReplaceUrls (ctx, res) {
		return true
	}
}

// 下面都可以改，这是我自己做的示例
// 最主要的是继承并实现 WebVPN 类，然后提供一些配置 config

const config = {
	// WebVPN 域名是否支持 https
	https: false,
	// WebVPN 服务端口
	port: 80,
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
	// 这个设置 0，可有效避免 Hostname/IP does not match certificate's altnames 错误
	NODE_TLS_REJECT_UNAUTHORIZED: 0
}

// 实例化
const vpn = new VPN(config)

// 启动 WebVPN 服务
vpn.start()
