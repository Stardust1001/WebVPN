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
		config.vpnDomain = config.site.host.replace('www', '')
		this.config = config
		this.mimes = ['json', 'js', 'css', 'html', 'image', 'video', 'audio']
		this.mimeRegs = [
			[/\.json/i, 'json'],
			[/\.js/i, 'js'],
			[/\.css/i, 'css'],
			[/\.(png|jpg|ico|svg|gif|webp|jpeg)/i, 'image'],
			[/\.(mp4|m3u8|ts|flv)[^a-zA-Z]/i, 'video'],
			[/\.(mp3|wav|ogg)/i, 'audio'],
			[/\.(html|php|do|asp|htm|shtml)/i, 'html'],
			[/\.(ttf|eot|woff|woff2)/i, 'font'],
			[/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)/i, 'pdf-office']
		]
		this.mimeDict = {
			'html': 'text/html',
			'text': 'text/plain',
			'js': 'application/javascript, application/x-javascript, text/javascript',
			'css': 'text/css',
			'image': 'image/png, image/jpg, image/jpeg, image/gif',
			'json': 'application/json',
			'video': 'video/mp4, application/vnd.apple.mpegurl',
			'audio': 'audio/webm, audio/mpeg',
			'stream': 'application/octet-stream, application/protobuffer'
		}
		this.ignoreRequestHeaderRegexps = [
			/^x-/i,
			/upgrade-insecure-requests/i
		]
		this.ignoreResponseHeaderRegexps = [
			/report-to/i,
			/(content-length|x-content-type-options|x-xss-protection|content-security-policy)/i,
		]

		this.noTransformMimes = ['font', 'json', 'image', 'video', 'audio', 'pdf']
		this.cacheMimes = ['js', 'css', 'font', 'image', 'video', 'audio', 'pdf']
		this.cacheDir = config.cacheDir || 'cache'
		this.checkCaches()

		this.ignoredIdentifiers = ['window', 'document', 'globalThis', 'parent', 'self', 'top', 'location']
		this.jsExternalName = '_ext_'
		this.jsScopePrefixCode = `
			// worker 里面创造 __context__ 环境
			if (!self.window) {
				var href = self.webvpn && set.webvpn.location.href;
				if (!href) {
					href = location.href.replace(location.origin, '#origin#');
				}
				var target = new URL(href);
				function copySource (source) {
					var copied = Object.assign({}, source);
					for (var key in source) copied[key] = source[key];
					return copied;
				}
				self.__location__ = Object.assign({}, copySource(self.location), copySource(target));
				for (var con of ['globalThis', 'self']) {
					self['__' + con + '__'] = new Proxy(self[con], {
						get (target, property, receiver) {
							if (['self', 'location'].includes(property)) {
								return self['__' + property + '__'];
							}
							var value = target[property];
							return (typeof value === 'function' && !value.prototype) ? value.bind(target) : value;
						},
						set (target, property, value) {
							if (['self', 'location'].includes(property)) {
								return false;
							}
							target[property] = value;
							return true;
						}
					});
				}
				self.__context__ = {
					self: __self__,
					globalThis: __globalThis__,
					location: __location__
				};
			}
			with (self.__context__) {
		`
		this.jsScopeSuffixCode = `
			}
		`

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
		const { host, pathname } = ctx.meta.target
		const filename = encodeURIComponent(pathname)
		if (!this.caches[host] || !this.caches[host].includes(filename)) {
			return null
		}
		await this.respondFile(ctx, path.join(this.cacheDir, host, filename))
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

		const { host, pathname } = ctx.meta.target
		const dir = path.join(this.cacheDir, host)
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
		const subdomain = ctx.headers.host.replace(this.config.vpnDomain, '')
		if (subdomain === 'www') {
			return await this.serveWww(ctx)
		} else if (subdomain === this.config.vpnDomain.slice(1)) {
			ctx.res.writeHead(302, { location: this.config.site.href })
			return
		}
		ctx.subdomain = subdomain

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

		if (!ctx.meta.done && res.data && this.shouldReplaceUrls(ctx, res)) {
			this.replaceUrls(ctx, res)
			if (ctx.meta.mime === 'html') {
				res.data = this.processHtml(ctx, res)
				res.data = this.processHtmlScopeCodes(ctx, res.data)
				res.data = this.appendScript(ctx, res)
			} else if (ctx.meta.mime === 'js') {
				res.data = this.processJsScopeCode(ctx, res.data)
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
		const domain = base32.decode(ctx.subdomain)
		const isIp = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(domain)
		const url = (isIp ? 'http://' : 'https://') + domain + ctx.url

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
		this.deleteIgnoreHeaders(this.ignoreRequestHeaderRegexps, header)
		this.setOriginHeaders(ctx, header)

		const options = {
			method,
			headers: header,
			redirect: 'manual',
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
		const headers = this.initResponseHeaders(ctx, res)

		if (headers.location) {
			ctx.res.writeHead(res.status, headers)
			ctx.meta.done = true
			return { status: res.status, headers }
		}

		let data = ''
		ctx.meta.mime = this.getMimeByResponseHeaders(headers) || ctx.meta.mime

		if (this.noTransformMimes.includes(ctx.meta.mime)) {
			if (headers['content-encoding'] === 'gzip') {
				delete headers['content-encoding']
			}
			ctx.meta.done = true
			if (ctx.meta.mime === 'json') {
				return {
					headers,
					status: res.status,
					data: await res.text()
				}
			}
			ctx.res.writeHead(res.status, headers)
			res.body.pipe(ctx.res)
			await new Promise((resolve) => {
				res.body.on('end', resolve)
			})
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
		const { site, vpnDomain } = this.config
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
			if (/&#x\w+;/.test(url)) {
				url = url.replaceAll(/&#x\w+;/g, ele => String.fromCharCode(parseInt(ele.slice(3, -1), 16)))
			}
			const source = prefix + new URL(url).host
			dict[source] = this.transformUrl(source.startsWith('http') ? source : (site.protocol + source)).slice(0, -1)
		})
		Object.entries(dict).sort((a, b) => b[0].length - a[0].length).forEach(ele => {
			const [key, value] = ele
			res.data = res.data.replaceAll(key, value)
		})
		return res.data
	}

	transformUrl (url) {
		const { host, origin } = new URL(url)
		const subdomain = base32.encode(host)
		return url.replace(origin, this.config.site.origin.replace('www', subdomain))
	}

	processHtml (ctx, res) {
		const match = res.data.match(/<meta\s+http-equiv=\"Content-Security-Policy\"[^>]+>/)
		if (match) {
			res.data = res.data.replace(match[0], '')
		}
		return res.data
	}

	processHtmlScopeCodes (ctx, code) {
		const matches = [...code.matchAll(/<script([^>]*)>([\S\s]*?)<\/script>/gi)].filter(match => {
			const typeIndex = match[1].indexOf('type=')
			let isScript = true
			if (typeIndex > 0) {
				const type = match[1].slice(typeIndex + 6).split(match[1][typeIndex + 5])[0]
				isScript = type.indexOf('text/javascript') >= 0 || type.indexOf('text/') < 0
			}
			return isScript && match[2]
		})
		matches.sort((a, b) => b.index - a.index)
		matches.forEach(match => {
			const index = match[0].length - match[2].length - 9 + match.index
			code = code.slice(0, index) + this.refactorJsScopeCode(ctx, match[2]) + code.slice(index + match[2].length)
		})
		return code
	}

	processJsScopeCode (ctx, code) {
		return this.refactorJsScopeCode(ctx, code)
	}

	refactorJsScopeCode (ctx, code) {
		const origin = this.config.site.origin.replace('www', base32.encode(ctx.meta.target.host))
		return this.jsScopePrefixCode.replace('#origin#', origin) + code + this.jsScopeSuffixCode
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
					base: '${base}',
					target: '${target.href}',
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
		<script src="${site.origin}/public/plugins.js"></script>
		${ctx.meta.appendScriptCode || ''}
		`
		const hasDoctype = /^\s*?\<\!DOCTYPE html\>/i.test(res.data)
		return (hasDoctype ? '<!DOCTYPE html>\n' : '') + code + data
	}

	processOthers (ctx, res) {
		if (ctx.meta.mime === 'json' && typeof res.data === 'string') {
			res.data = JSON.stringify(res.data)
		}
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
		if (typeof res.headers.raw === 'function') {
			headers = res.headers.raw()
			for (let key in headers) {
				if (headers[key].length === 1) {
					headers[key] = headers[key][0]
				}
			}
		} else {
			headers = res.headers
		}
		const acao = headers['access-control-allow-origin']
		if (acao && acao !== '*') {
			const host = acao.indexOf('http') >= 0 ? new URL(acao).host : acao
			headers['access-control-allow-origin'] = acao.replace(host, base32.encode(host) + this.config.vpnDomain)
		} else {
			headers['access-control-allow-origin'] = '*'
		}
		headers['content-type'] = headers['content-type'] || 'text/html'
		const csp = headers['content-security-policy']
		if (csp && csp.indexOf('frame-ancestors') >= 0) {
			headers['content-security-policy'] = csp.replace('frame-ancestors', 'frame-ancestors ' + this.config.site.origin.replace('www', '*'))
		}
		if (headers['location']) {
			let location = headers['location']
			if (!location.startsWith('http')) {
				if (location[0] === '/') {
					location = ctx.meta.target.origin + location
				}
			}
			headers['location'] = this.transformUrl(location)
		}
		return headers
	}

	getMimeByResponseHeaders (headers) {
		const contentType = headers['content-type'] || ''
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
			headers['host'] = this.convertHost(headers['host'])
		}
		if (headers['origin']) {
			const host = new URL(headers['origin']).host
			headers['origin'] = headers['origin'].replace(host, this.convertHost(host))
		}
		const referer = headers['referer']
		if (referer) {
			if (referer.indexOf(this.config.site.host) || referer.indexOf(this.config.vpnDomain) < 0) {
				delete headers['referer']
			} else {
				const host = new URL(referer).host
				headers['referer'] = referer.replace(host, this.convertHost(host))
			}
		}
	}

	convertHost (host) {
		return base32.decode(host.split('.')[0])
	}

	async convertCharsetData (ctx, headers, res) {
		if (ctx.meta.mime !== 'html' && ctx.meta.mime !== 'js') {
			return res.text()
		}
		const buffer = Buffer.from(await res.arrayBuffer())
		const text = iconv.decode(buffer, 'utf-8')
		let contentType = headers['content-type'] || ''
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
			return /^[\w\$_]+\((\{|\[)/.test(data)
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

	beforeRequest (ctx) { }

	beforeFetch (ctx) { }

	afterRequest (ctx, res) { }

	beforeResponse (ctx, res) { }
}

export default WebVPN
