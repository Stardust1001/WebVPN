import os from 'os'
import cluster from 'cluster'
import childProcess from 'child_process'
import WebVPN from './webvpn.js'

// main.js 是个示例，如果要创建一个 WebVPN 服务，需要继承并实例化 WebVPN 类
// 有些网站需要特殊处理，那么可以覆盖父类的某个方法，加上自定义的实现，来自定义处理

class VPN extends WebVPN {
	constructor (config) {
		super(config)
	}

	// 发送请求之前
	async beforeRequest (ctx) {

	}

	// 发送 fetch 之前
	async beforeFetch (ctx, options) {
		if (ctx.meta.url.startsWith('http://www.baidu.com/link?url=')) {
			delete options.headers['host']
			delete options.headers['origin']
			delete options.headers['referer']
			delete options.headers['cookie']
		}
	}

	// 获取请求之后
	afterRequest (ctx, res) {
		if (ctx.url.indexOf('v.qq.com') > 0) {
			ctx.meta.confirmJump = true
		}
		if (ctx.url.indexOf('filesaver') > 0) {
			res.data = res.data.replaceAll(/window\.window===window/g, 'true')
		}
	}

	// 返回响应之前
	async beforeResponse (ctx, res) {
		if (ctx.meta.url.indexOf('hub.com') > 0) {
			res.data = res.data.replaceAll('request.timeout = 10000;', '')
		}
		if (ctx.meta.url.indexOf('module/qplayer.js') > 0) {
			res.data = res.data.replace('ua.isiPhone=', 'ua.isiPhone=true||')
			res.data = res.data.replace('$.qPlayer.isQQDomain=', '$.qPlayer.isQQDomain=true||')
		}
		if (ctx.meta.url.indexOf('.9ced5b8d.') > 0) {
			res.data = res.data.replaceAll('children:"app.pangolin.exchange"', `children:"${this.config.site.hostname}"`)
		}
	}

	// 是否要替换这个 res 响应里的链接
	shouldReplaceUrls (ctx, res) {
		return true
	}

	// 转换汉字
	convertChinease (text) {
		// 如果需要转换汉字，达到网络传输中隐藏网页汉字内容的功能，可以用这个
		// 至于你为什么需要隐藏汉字，实际上我也不知道
		text = String.fromCharCode(text.charCodeAt(0) + 1)
		return `#${text}#`
	}
}

// 下面都可以改，这是我自己做的示例
// 最主要的是继承并实现 WebVPN 类，然后提供一些配置 config

const config = {
	// WebVPN 服务端口
	port: 1001,
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
	// 是否隐藏汉字（我也不知道你为什么要隐藏汉字，我不知道是出于什么用途）
	hideChinease: false,
	// 这个设置 0，可有效避免 Hostname/IP does not match certificate's altnames 错误
	NODE_TLS_REJECT_UNAUTHORIZED: 0
}

// 实例化
const vpn = new VPN(config)

// 启动 WebVPN 服务
vpn.start()

if (cluster.isMaster) {
	setTimeout(() => {
		// 运行后自动打开 WebVPN 网址
		// childProcess.exec('open ' + new URL(devSite).origin)
	}, 500)
}
