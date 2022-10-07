import fs from 'fs'
import https from 'https'
import http from 'http'
import path from 'path'
import cluster from 'cluster'
import chalk from 'chalk'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import fetch from 'node-fetch'
import iconv from 'iconv-lite'
import base32 from 'base32'

import { fsUtils } from './utils.js'

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

class WebVPN {
	constructor (config) {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = config.NODE_TLS_REJECT_UNAUTHORIZED || 0
		config.vpnDomain = config.site.hostname.replace('www', '')
		this.config = config
		this.mimes = ['json', 'js', 'css', 'html', 'image', 'video', 'audio']
		this.mimeRegs = [
			[/\.json/, 'json'],
			[/\.js/, 'js'],
			[/\.css/, 'css'],
			[/\.(png|jpg|ico|svg|gif|webp|jpeg)/, 'image'],
			[/\.(mp4|m3u8|ts|flv)[^a-zA-Z]/, 'video'],
			[/\.(mp3|wav|ogg)/, 'audio'],
			[/\.(html|php|do|asp|htm|shtml)/, 'html'],
			[/\.(ttf|eot|woff|woff2)/, 'font'],
			[/\.pdf/, 'pdf'],
			[/\.(doc|docx)/, 'doc'],
			[/\.(xls|xlsx)/, 'xls'],
			[/\.(ppt|pptx)/, 'ppt'],
		]
		this.mimeDict = {
			'html': 'text/html',
			'text': 'text/plain',
			'js': 'application/javascript, application/x-javascript',
			'css': 'text/css',
			'image': 'image/png, image/jpg, image/jpeg, image/gif',
			'json': 'application/json',
			'video': 'video/mp4, application/vnd.apple.mpegurl',
			'audio': 'audio/webm, audio/mpeg',
			'stream': 'application/octet-stream, application/protobuffer'
		}
		this.ignoreRequestHeaderRegexps = []
		this.ignoreResponseHeaderRegexps = [
			/-policy/i,
			/report-to/i,
			/(content-length|x-content-type-options|x-xss-protection|x-frame-options)/i,
		]

		this.noTransformMimes = ['font', 'json', 'image', 'video', 'audio', 'pdf']
		this.cacheMimes = ['js', 'css', 'font', 'image', 'video', 'audio', 'pdf']
		this.cacheDir = config.cacheDir || 'cache'
		this.checkCaches()

		this.public = []
		this.initPublic()
	}

	async checkCaches () {
		if (this.config.cache) {
			this.caches = { }
			const dirs = await fsUtils.listDir(this.cacheDir)
			dirs.forEach(async dir => {
				this.caches[dir] = await fsUtils.listDir(path.join(this.cacheDir, dir))
			})
		}
	}

	async initPublic () {
		fsUtils.listDir('public').then(files => {
			this.public = files.map(file => path.join('public', file))
		})
	}

	start () {
		if (this.config.numProcesses > 1 && cluster.isMaster) {
			this.fork()
		} else {
			this.createApp()
		}
	}

	async serveWww (ctx) {
		if (ctx.url === '/') {
			await this.respondFile(ctx, path.join('public', 'index.html'))
		} else {
			await this.checkPublic(ctx)
		}
	}

	async checkPublic (ctx) {
		const parts = ctx.url.split('/public/')
		let filepath = parts[1] && path.join('public', parts[1]) || ''
		filepath = filepath.split('?')[0]

		if (this.public.includes(filepath)) {
			await this.respondFile(ctx, filepath)
			return true
		}
		return false
	}

	async getCache (ctx) {
		const { hostname, pathname } = ctx.meta.target
		const filename = encodeURIComponent(pathname)
		if (!this.caches[hostname] || !this.caches[hostname].includes(filename)) {
			return null
		}
		await this.respondFile(ctx, path.join(this.cacheDir, hostname, filename))
		return true
	}

	async setCache (ctx, res) {
		if (
			!this.config.cache
			|| !this.cacheMimes.includes(ctx.meta.mime)
			|| !res.data
			|| ctx.meta.cache === false
		) {
			return
		}

		const { hostname, pathname } = ctx.meta.target
		const dir = path.join(this.cacheDir, hostname)
		if (!await fsUtils.exists(dir)) {
			await fsUtils.mkdir(dir)
		}
		await fsUtils.write(path.join(dir, encodeURIComponent(pathname)), res.data)
	}

	fork () {
		for (let i = 0; i < this.config.numProcesses; i++) {
			cluster.fork()
		}
		cluster.on('listening', (worker, address) => {
			console.log(chalk.green(`listening: worker ${worker.process.pid} - Address: ${address.address}:${address.port}`))
		})
		cluster.on('exit', (worker, code, signal) => {
			console.log(chalk.yellow(`工作进程 ${worker.process.pid} 关闭 ${signal || code}. 重启中...`) + '\n')
			cluster.fork()
		})
	}

	createApp () {
		const { config } = this
		const app = new Koa()
		app.use(bodyParser())
		app.use(this.proxyRoute.bind(this))
		const host = config.host || '0.0.0.0'
		const port = config.port || config.site.port * 1 || (config.site.protocol === 'http:' && 80 || 443)
		app.listen(port, host)
	}

	async proxyRoute (ctx, next) {
		ctx.subdomain = ctx.headers['host'].split('.')[0]

		if (ctx.subdomain === 'www') {
			return await this.serveWww(ctx)
		}

		const isPublic = await this.checkPublic(ctx)
		if (isPublic) {
			return
		}

		this.routeInit(ctx)

		if (this.config.cache && ctx.meta.cache !== false) {
			if (await this.getCache(ctx)) {
				return
			}
		}

		if (await this.beforeRequest(ctx)) {
			return
		}

		if (this.noTransformMimes.includes(ctx.meta.mime)) {
			return await this.respondPipe(ctx)
		}

		let res = null
		try {
			res = await this.request(ctx)
		} catch (err) {
			ctx.body = err
			return
		}

		this.deleteIgnoreHeaders(this.ignoreResponseHeaderRegexps, res.headers)
		Object.keys(res.headers).forEach(key => ctx.set(key, res.headers[key]))

		if (res.status >= 300 && res.status < 400) {
			ctx.body = res.data
			return
		}

		if (!ctx.meta.done && (await this.afterRequest(ctx, res))) {
			return
		}

		if (!ctx.meta.done && this.shouldReplaceUrls(ctx, res)) {
			this.replaceUrls(ctx, res)
			if (ctx.meta.mime === 'html') {
				res.data = this.appendScript(ctx, res)
			}
		}

		if (!ctx.meta.done) {
			this.processOthers(ctx, res)
		}

		if (!ctx.meta.done && (await this.beforeResponse(ctx, res))) {
			return
		}

		this.setCache(ctx, res)

		ctx.body = res.data
	}

	routeInit (ctx) {
		const url = 'https://' + base32.decode(ctx.subdomain) + ctx.url

		ctx.meta = {
			url,
			mime: this.getResponseType(ctx, url),
			target:  new URL(url),
			host: ctx.headers['host'],
			origin: ctx.headers['origin'],
			referer: ctx.headers['referer']
		}
	}

	async respondFile (ctx, filepath) {
		ctx.res.writeHead(200)
		const stream = fs.createReadStream(filepath)
		await new Promise(resolve => {
			stream.pipe(ctx.res)
			stream.on('end', resolve)
		})
	}

	async respondPipe (ctx) {
		const headers = { ...ctx.headers }
		this.setOriginHeaders(ctx, headers)
		this.deleteIgnoreHeaders(this.ignoreRequestHeaderRegexps, headers)

		const method = ctx.request.method.toLowerCase()
		const { protocol, hostname, port } = ctx.meta.target

		if (ctx.meta.userAgent) {
			headers['user-agent'] = ctx.meta.userAgent
		}

		const isHttps = protocol.startsWith('https')
		const options = {
			method,
			protocol,
			hostname,
			headers,
			path: ctx.meta.url.slice(protocol.length + 2 + hostname.length + (port ? port.length + 1 : 0)),
			port: port * 1 || (isHttps ? 443 : 80)
		}
		if (isHttps) {
			options.agent = httpsAgent
		}
		await new Promise(resolve => {
			const lib = isHttps ? https : http
			const func = method === 'get' ? lib.get : lib.request
			func(options, res => {
				const headers = this.initResponseHeaders(ctx, res)
				this.deleteIgnoreHeaders(this.ignoreResponseHeaderRegexps, headers)
				ctx.res.writeHead(res.statusCode, headers)
				res.pipe(ctx.res)
				res.on('end', resolve)
			})
		})
	}

	async request (ctx) {
		const { method, header } = ctx.request
		this.setOriginHeaders(ctx, header)
		this.deleteIgnoreHeaders(this.ignoreRequestHeaderRegexps, header)

		if (ctx.meta.userAgent) {
			header['user-agent'] = ctx.meta.userAgent
		}
		const options = {
			method,
			headers: header,
			...this.getRequestConfig(ctx)
		}
		if (method === 'POST') {
			options.body = this.processRequestBody(ctx)
		}
		const result = await this.beforeFetch(ctx, options)
		if (result) {
			return result
		}
		try {
			return await this.fetchRequest(ctx, options)
		} catch (err) {
			const msg = 'request failed: ' + ctx.meta.url + '\n' + err.toString()
			console.log(chalk.red(msg) + '\n')
			throw msg
		}
	}

	processRequestBody (ctx) {
		let body = ctx.request.body
		try {
			body = JSON.stringify(ctx.request.body)
		} catch {
			console.log(chalk.yellow(`POST 请求非 json 请求体解析错误`) + '\n')
		}
		return body
	}

	async fetchRequest (ctx, options) {
		const res = await fetch(ctx.meta.url, options)
		if (res.redirected) {
			this.setRedirectedUrlMeta(ctx, res.url)
		}
		const headers = this.initResponseHeaders(ctx, res)

		let data = ''
		ctx.meta.mime = this.getMimeByResponseHeaders(headers) || ctx.meta.mime

		if (this.noTransformMimes.includes(ctx.meta.mime)) {
			if (headers['content-encoding'] === 'gzip' && ctx.meta.mime === 'json') {
				delete headers['content-encoding']
				ctx.body = await res.text()
				ctx.meta.done = true
			} else {
				ctx.res.writeHead(res.status, headers)
				res.body.pipe(ctx.res)
				await new Promise((resolve) => {
					res.body.on('end', resolve)
				})
				ctx.meta.done = true
			}
		} else {
			ctx.status = res.status
			delete headers['content-encoding']
			data = await this.convertCharsetData(ctx, headers, res)
			if (this.isJsonpResponse(data, ctx) || this.isJsonResponse(data, ctx)) {
				ctx.body = data
				ctx.meta.done = true
			}
		}
		return {
			status: res.status,
			data,
			headers
		}
	}

	replaceUrls (ctx, res) {
		const { mime } = ctx.meta
		const matches = []
		ctx.meta.base = this.getBase(ctx, res)
		if (mime === 'html') {
			matches.push(...this.getHtmlLinkMatches(ctx, res))
		}
		if (['html', 'css'].includes(mime)) {
			matches.push(...this.getCssUrlMatches(ctx, res))
		}
		res.data = this.replaceMatches(ctx, res, matches)

		if (['html', 'js'].includes(mime)) {
			res.data = this.replaceLocationOperations(ctx, res)
			res.data = this.customReplace(ctx, res)
		}

		const { hideChinease = this.config.hideChinease } = ctx.meta
		if (hideChinease && typeof res.data === 'string') {
			res.data = this.chinease2Unicode(ctx, res)
		}
	}

	getBase (ctx, res) {
		const match = res.data.match(/\<base\s+href=(\"|\')[^\"\']+/)
		if (match) {
			const text = match[0]
			const index = Math.max(text.indexOf('"'), text.indexOf('\''))
			return text.slice(index + 1)
		}
		return ctx.meta.target.pathname.split('/').slice(0, -1).join('/') + '/'
	}

	getHtmlLinkMatches (ctx, res) {
		return [...new Set(res.data.match(/\s(href|src|action|srcset|poster)=(\"|\')?(http|\/\/)[^\s\>]*/g))]
	}

	getCssUrlMatches (ctx, res) {
		return [
			...new Set(res.data.match(/url\([\"\']?(http|\/\/)[^\"\')]+/g)),
			...new Set(res.data.match(/@import\s[\"\'](http|\/\/)[^\"\']+/g))
		]
	}

	replaceMatches (ctx, res, matches) {
		const { vpnDomain } = this.config
		const dict = {}
		matches.filter(m => m.indexOf(vpnDomain) < 0).forEach(match => {
			let url = ''
			let prefix = ''
			if (match.slice(0, match.indexOf('//')).indexOf('http') >= 0) {
				url = match.slice(match.indexOf('http'), -1)
				prefix = match.indexOf('https') > 0 ? 'https://' : 'http://'
			} else {
				url = 'https:' + match.slice(match.indexOf('//'), -1)
				prefix = '//'
			}
			const { hostname } = new URL(url)
			const source = prefix + hostname
			const desti = prefix.replace('https', 'http') + base32.encode(hostname) + vpnDomain
			dict[source] = desti
		})
		Object.entries(dict).sort((a, b) => b[0].length - a[0].length).forEach(ele => {
			const [key, value] = ele
			res.data = res.data.replaceAll(key, value)
		})
		return res.data
	}

	replaceLocationOperations (ctx, res) {
		let data = res.data
		const site = this.config.site

		// 下面的获取判断，用了 =，所以 == === 也包含在内了，现在 == === 的左值 window, document 等, 也需要替换
		data = data.replaceAll(/[^\.](window|document|globalThis|parent|self|top)\s*==/g, match => {
			return match.replace(/(window|document|globalThis|parent|self|top)/, m => {
				return `(${m} === window.${m} ? window._${m} : ${m})`
			})
		})
		// 要获取 window, document 等，返回给他们 _window, _document 等
		data = data.replaceAll(/=\s*(window|document|globalThis|parent|self|top)\s*[,;\)\}\:\?]/g, match => {
			return match.replace(/(window|document|globalThis|parent|self|top)/, m => {
				return `(${m} === window.${m} ? window._${m} : ${m})`
			})
		})
		// 要访问 window.location, document.location 等，让他们访问 window._location，不管是获取还是赋值，都这样
		data = data.replaceAll(/[^_](window|document|globalThis|parent|self|top)\.location/g, match => {
			return match[0] + 'window._location'
		})

		// 要访问 location.host 等，让访问 window._location 的 host 等
		data = data.replaceAll(/[\s,;\?:\{\(\|=]location\.(host|hostname|href|origin|port|protocol|assign|replace)/g, match => {
			return match[0] + '_' + match.slice(1)
		})

		data = data.replaceAll(/window\.navigate\(/g, 'window._navigate(')
		return data
	}

	customReplace (ctx, res) {
		// 上面的 location 转换大概比较成熟，这里的不怎么成熟，所以放到 customReplace 方法里
		let data = res.data

		// 要直接访问 location 变量，让访问 window._location
		// 注意，暂时去掉了右边的小括号判断 )，因为可能这个 location 是函数参数，不能替换为下面的表达式，暂时先这样
		new Set(data.match(/[\s,;\?:\{\(\|]location\s*[,;\?:\}]/g)).forEach(match => {
			const [left, right] = match.split('location')
			// 右边是 : ，不一定是三元运算符，可能是 { a: 1 } 这样的属性名:属性值
			if ((right.trim()[0] === ':') && !left.trim().endsWith('?')) {
				return match
			}
			const result = match.replace('location', '(location == window.location ? window._location : location)')
			data = data.replaceAll(match, result)
		})

		// 要直接给 location 变量赋值，让给 window.location._href 变量赋值
		new Set(data.match(/[\s,;\?:\{\(]location\s*\=[^,;\}\)]+/g)).forEach(match => {
			const left = match.slice(match.indexOf('location'), match.indexOf('=') + 1)
			const [prefix, right] = match.split(left)
			// 如果右值是 window.location ...，说明这是赋值给名为 location 的变量，这个不需要转换
			if (/(window|document|globalThis|parent|self|top)\._?location/.test(right)) {
				return
			}
			// location=no location=1 是设置滚动条的东西（虽然，这种手动判断的方式并不优雅，先这样吧）
			const trimedRight = right.trim()
			if (trimedRight.startsWith('no') || trimedRight.startsWith('1')) {
				return
			}
			// TODO, 这里有可能会有问题，赋值表达式的右边部分，目前做的比较简单
			const result = prefix + `(location == window.location) ? window.location._href=${right} : location=${right}`
			data = data.replaceAll(match, result)
		})

		return data
	}

	appendScript (ctx, res) {
		const { site, interceptLog } = this.config
		const { disableJump = this.config.disableJump, confirmJump = this.config.confirmJump } = ctx.meta
		const { base, target } = ctx.meta
		const { data } = res
		const code = `
		<script>
			(function () {
				window.webvpn = {
					site: '${site.href}',
					siteHostname: '${site.hostname}',
					siteOrigin: '${site.origin}',
					base: '${base}',

					targetUrl: '${target.href}',

					interceptLog: ${interceptLog},
					disableJump: ${disableJump},
					confirmJump: ${confirmJump}
				};

				${ctx.meta.appendCode || ''}
			})();
		</script>
		<script src="${site.origin}/public/htmlparser.js"></script>
		<script src="${site.origin}/public/html2json.js"></script>
		<script src="${site.origin}/public/base32.js"></script>
		<script src="${site.origin}/public/append.js"></script>
		${ctx.meta.appendScriptCode || ''}
		`
		return code + data
	}

	processOthers (ctx, res) {
		if (ctx.meta.mime === 'json' && typeof res.data === 'string') {
			res.data = JSON.stringify(res.data)
		}
	}

	setRedirectedUrlMeta (ctx, url) {
		Object.assign(ctx.meta, {
			url,
			mime: this.getResponseType(ctx, url),
			target: new URL(url)
		})
	}

	getResponseType (ctx, url) {
		const index = url.indexOf('?')
		const link = index < 0 ? url : url.slice(0, index)
		for (let reg of this.mimeRegs) {
			if (reg[0].test(link)) {
				return reg[1]
			}
		}
		if (new URL(link).pathname === '/') {
			return 'html'
		}
		return 'text'
	}

	getRequestConfig (ctx) {
		const config = { }
		if (ctx.meta.mime === 'image') {
			config.responseType = 'arraybuffer'
		}
		return config
	}

	initResponseHeaders (ctx, res) {
		let headers = {}
		if (typeof res.headers.keys === 'function') {
			const keys = [...res.headers.keys()]
			for (let key of keys) {
				headers[key] = res.headers.get(key)
			}
		} else {
			headers = res.headers
		}
		const acao = headers['access-control-allow-origin']
		if (acao && acao !== '*') {
			const hostname = new URL(acao).hostname
			headers['access-control-allow-origin'] = acao.replace(hostname, base32.encode(hostname) + this.config.vpnDomain)
		} else {
			headers['access-control-allow-origin'] = '*'
		}
		headers['content-type'] = headers['content-type'] || 'text/html'
		return headers
	}

	getMimeByResponseHeaders (headers) {
		const contentType = headers['content-type']
		const mime = Object.keys(this.mimeDict).find(mime => {
			const parts = this.mimeDict[mime].replaceAll(' ', '').split(',')
			return parts.some(part => {
				return contentType.split(';')[0].indexOf(part) >= 0
			})
		})
		if (!mime && contentType.startsWith('image/')) {
			return 'image'
		}
		return mime
	}

	setOriginHeaders (ctx, headers) {
		if (headers['host']) {
			headers['host'] = this.convertHostname(headers['host'])
		}
		if (headers['origin']) {
			const hostname = new URL(headers['origin']).hostname
			headers['origin'] = headers['origin'].replace(hostname, this.convertHostname(hostname))
		}
		const referer = headers['referer']
		if (referer) {
			if (referer.indexOf(this.config.site.hostname) || referer.indexOf(this.config.vpnDomain) < 0) {
				delete headers['referer']
			} else {
				const hostname = new URL(referer).hostname
				headers['referer'] = referer.replace(hostname, this.convertHostname(hostname))
			}
		}
	}

	convertHostname (hostname) {
		return base32.decode(hostname.split('.')[0])
	}

	async convertCharsetData (ctx, headers, res) {
		if (ctx.meta.mime !== 'html') {
			return res.text()
		}
		const buffer = Buffer.from(await res.arrayBuffer())
		const text = iconv.decode(buffer, 'utf-8')
		let contentType = headers['content-type']
		let charset = contentType.split('charset=')[1]
		if (!charset) {
			let match = text.match(/<meta charset=[\"\'][^"'\/>]+/)
			if (!match) {
				match = text.match(/<meta http-equiv=\"Content-Type\" content=\"text\/html;\s*charset=[^"'\/>]+/i)
			}
			if (!match) {
				return text
			}
			charset = match[0].split('charset=')[1].replaceAll('"', '').toLowerCase()
			if (charset === 'utf-8') {
				return text
			}
			contentType = 'text/html; charset=' + charset
		} else {
			if (charset.toLowerCase() === 'utf-8') {
				return text
			}
		}
		headers['content-type'] = contentType.replace(charset, 'utf-8')
		const data = iconv.decode(Buffer.from(buffer), charset)
		return data.replace(/<meta charset="\w+">/, '<meta charset="utf-8">')
	}

	isJsonpResponse (data, ctx) {
		if (ctx.meta.mime === 'html') {
			return /^[a-zA-Z0-9\$_]+\((\{|\[)/.test(data)
		}
		return false
	}

	isJsonResponse (data, ctx) {
		if (ctx.meta.mime === 'html') {
			try {
				JSON.parse(data)
				return true
			} catch {
				return false
			}
		}
		return false
	}

	deleteIgnoreHeaders (regexps, headers) {
		const keys = Object.keys(headers)
		for (let key of keys) {
			if (regexps.some(reg => reg.test(key))) {
				delete headers[key]
			}
		}
	}

	shouldReplaceUrls (ctx, res) {
		return true
	}

	chinease2Unicode (ctx, res) {
		const text = res.data
		if (!text) {
			return ''
		}
		var unicode = ''
		for (var i = 0; i < text.length; i++) {
			var temp = text.charAt(i)
			if (this.isChinese(temp)) {
				unicode += this.convertChinease(temp)
			} else {
				unicode += temp
			}
		}
		return unicode
	}

	isChinese (text) {
		return /[\u4e00-\u9fa5]/.test(text)
	}

	convertChinease (text) {
		return text
	}

	beforeRequest (ctx) { }

	beforeFetch (ctx) { }

	afterRequest (ctx, res) { }

	beforeResponse (ctx, res) { }
}

export default WebVPN
