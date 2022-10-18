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

import { fsUtils } from './utils.js'

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

class WebVPN {
	constructor (config) {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = config.NODE_TLS_REJECT_UNAUTHORIZED || 0
		this.config = config
		this.mimes = ['json', 'js', 'css', 'html', 'image', 'video', 'audio']
		this.mimeRegs = [
			[/\.json/, 'json'],
			[/\.js/, 'js'],
			[/\.css/, 'css'],
			[/\.(png|jpg|ico|svg|gif|webp|jpeg)/, 'image'],
			[/\.(mp4|m3u8|ts|flv)[^a-zA-Z]/, 'video'],
			[/\.(mp3|wav|ogg)/, 'audio'],
			[/\.(html|php|do|asp|htm)/, 'html'],
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
		this.ignoredPrefixes = ['mailto:', 'sms:', 'tel:', 'javascript:', 'data:', 'blob:']

		this.noTransformMimes = ['font', 'json', 'image', 'video', 'audio', 'pdf']
		this.cacheMimes = ['js', 'css', 'font', 'image', 'video', 'audio', 'pdf']
		this.cacheDir = config.cacheDir || 'cache'
		this.checkCaches()

		this.ignoredIdentifiers = ['window', 'document', 'globalThis', 'parent', 'self', 'top', 'location']
		this.jsExternalName = '_ext_'
		this.jsScopePrefixCode = `
			var ${this.jsExternalName} = {};
			(function () {
				var window = _window;
				var document = _document;
				var globalThis = _globalThis;
				var parent = _parent;
				var self = _self;
				var top = _top;
				var location = _location;\n
		`
		this.jsScopeSuffixCode = `
			})();
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

	async checkPublic (ctx) {
		const parts = ctx.url.split('/public/')
		let filepath = parts[1] && path.join('public', parts[1]) || ''
		filepath = filepath.split('?')[0]

		if (ctx.url.split('/').every(part => ['', 'proxy', 'all', 'single'].includes(part))) {
			filepath = path.join('public', 'index.html')
		}

		if (this.public.includes(filepath)) {
			ctx.body = await fsUtils.read(filepath)
			return true
		}
		return false
	}

	getCache (ctx) {
		const { hostname, pathname } = ctx.meta.target
		const filename = encodeURIComponent(pathname)
		if (!this.caches[hostname] || !this.caches[hostname].includes(filename)) {
			return null
		}
		return fs.createReadStream(path.join(this.cacheDir, hostname, filename))
	}

	async setCache (ctx, res) {
		if (
			!this.config.cache
			|| !this.cacheMimes.includes(ctx.meta.mime)
			// || typeof res.data !== 'string'
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
		const filepath = path.join(dir, encodeURIComponent(pathname))
		await fsUtils.write(filepath, res.data)
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
		if (
			/^\/favicon.*\.(ico|png)$/.test(ctx.url) ||
			ctx.url.endsWith('.js.map') ||
			ctx.url.endsWith('.js.sourcemap')
		) {
			return
		}

		const isPublic = await this.checkPublic(ctx)
		if (isPublic) {
			return
		}

		this.routeInit(ctx)

		if (!ctx.meta.url) {
			const err = 'Invalid proxy target : ' + ctx.url
			if (this.checkLogUrlError(ctx)) {
				console.log(chalk.red(err) + '\n')
			}
			ctx.body = err
			return
		}

		if (this.config.cache && ctx.meta.target && ctx.meta.cache !== false) {
			const stream = this.getCache(ctx)
			if (stream) {
				ctx.res.writeHead(200)
				await new Promise(resolve => {
					stream.pipe(ctx.res)
					stream.on('end', resolve)
				})
				return
			}
		}

		this.processCookies(ctx)

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

		if (ctx.meta.done) {
			this.setCache(ctx, res)
			return
		}

		if (await this.afterRequest(ctx, res)) {
			return
		}

		if (ctx.meta.done) {
			this.setCache(ctx, res)
			return
		}

		if (this.shouldReplaceUrls(ctx, res)) {
			this.replaceUrls(ctx, res)
			if (ctx.meta.mime === 'html') {
				res.data = this.processHtmlScopeCodes(res.data, ctx.meta.url)
				res.data = this.appendScript(ctx, res)
			} else if (ctx.meta.mime === 'js') {
				res.data = this.processJsScopeCode(res.data, ctx.meta.url)
			}
		}
		if (ctx.meta.done) {
			this.setCache(ctx, res)
			return
		}

		this.processOthers(ctx, res)
		if (ctx.meta.done) {
			this.setCache(ctx, res)
			return
		}

		if (ctx.meta.done) {
			this.setCache(ctx, res)
			return
		}

		if (await this.beforeResponse(ctx, res)) {
			return
		}

		this.setCache(ctx, res)

		ctx.body = res.data
	}

	routeInit (ctx) {
		ctx.meta = {}
		ctx.meta.suffixMime = this.getSuffixMime(ctx)
		this.initCtxUrl(ctx)
		const ok = this.initUrlMeta(ctx)
		if (!ok) {
			if (this.processInvalidUrl(ctx)) {
				this.initCtxUrl(ctx)
				this.initUrlMeta(ctx)
			}
		}
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
		// const isHttps = ctx.meta.target.protocol.startsWith('https')
		const options = {
			method,
			headers: header,
			...this.getRequestConfig(ctx)
		}
		// if (isHttps) {
		// 	options.agent = httpsAgent
		// }
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
		if (['html', 'js'].includes(mime)) {
			matches.push(...this.getImportUrlMatches(ctx, res))
		}
		res.data = this.replaceMatches(ctx, res, matches)

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
		// 替换 href src action srcset poster 链接
		// 前面加上 \s-，只匹配 html 元素里的 src=，不匹配如 a.src= 之类的 js 或其他代码，- 是为了 data-src 之类的属性
		// 2022-06-25 更新，在 http 后面加了 ?，为了匹配 href="css/index.css" 之类的直接同目录路径
		const regexp = /[\s-](href|src|action|srcset|poster)=(\"|\')?(\.|\/|http)?[^\s\>]*/g
		return this.getRegExpMatches(ctx, res, regexp, (match) => {
			let index = 0
			let symbol = ''
			const symbols = ['\'', '"', '=']
			for (let ele of symbols) {
				const i = match.indexOf(ele)
				if (i >= 0) {
					index = i
					symbol = ele
					break
				}
			}
			return [match, index, symbol]
		})
	}

	getCssUrlMatches (ctx, res) {
		// 替换 url( 链接
		const urlMatches = this.getRegExpMatches(ctx, res, /url\([\"\']?[^\"\')]+/g, (match) => {
			const symbol = match.indexOf('"') > 0 ? '"' : (match.indexOf('\'') > 0 ? '\'' : '')
			const index = symbol ? match.indexOf(symbol) : match.indexOf('(')
			return [match, index, symbol]
		})
		// 替换 @import 链接
		const importMatches = this.getRegExpMatches(ctx, res, /@import\s[\"\'][^\"\']+/g, (match) => {
			const symbol = match.indexOf('"') > 0 ? '"' : '\''
			const index = match.indexOf(symbol)
			return [match, index, symbol]
		})
		return [...urlMatches, ...importMatches]
	}

	getImportUrlMatches (ctx, res) {
		// 替换 import 的链接
		const regexps = [
			// import ... from
			/import[A-Za-z0-9\$\_\{\}\s,]+from\s*[\"\'][^\"\']+/g,
			// import(...)
			/import\s*\([\"\'][^\"\']+/g,
			// \s; import "|'  这是单单的 import"./1.js" import "2.js" 形式的导入
			// 避免匹配到无关的字符串，前面加上 \s; 匹配，表明这是一个以 import 开头的导入
			// 后面匹配 ,; 并且是 + 而非 * 模式，因为要去除 "... import",; 字符串的情况
			// 但并不完美，有问题再看看处理
			/[\s;]import\s*[\"\'][^\"\',;\)]+/g,
			// 以 import"./1.js" import"2.js" 直接开头的形式
			/^import\s*[\"\'][^\"\',;\)]+/g,
		]
		const handler = (match) => {
			match = match.split(')')[0]
			let index = 0
			let symbol = ''
			const symbols = ['\'', '"']
			for (let ele of symbols) {
				const i = match.indexOf(ele)
				if (i >= 0) {
					index = i
					symbol = ele
					break
				}
			}
			return [match, index, symbol]
		}
		return regexps.reduce((all, regexp) => {
			const matches = this.getRegExpMatches(ctx, res, regexp, handler)
			return all.concat(matches)
		}, [])
	}

	getRegExpMatches (ctx, res, regexp, handler) {
		let matches = res.data.match(regexp) || []
		matches = this.processMatches(ctx, res, matches)
		return Array.from(new Set(matches)).map(handler)
	}

	processMatches (ctx, res, matches) {
		return matches.filter(match => {
			const url = this.getMatchUrl(match).trim()
			// 排除空链接
			if (!url) {
				return false
			}
			// 排除根链接
			if (url === '/') {
				return false
			}
			// 清除无效协议链接
			if (this.ignoredPrefixes.some(prefix => url.indexOf(prefix) >= 0)) {
				return false
			}
			if (ctx.meta.proxyType === 'single') {
				// 排除 外部域名 链接
				if (url.indexOf('//') >= 0 && url.split('//')[1].split('/')[0] !== ctx.meta.target.hostname) {
					return false
				}
			}
			return true
		}).map(match => {
			const parts = match.split(/(\"|\')/)
			if (parts.length > 4) {
				return parts.slice(0, 3).join('')
			}
			return match
		})
	}

	replaceMatches (ctx, res, matches) {
		const set = new Set()
		const uniqueMatches = []
		matches.forEach(item => {
			if (!set.has(item[0])) {
				set.add(item[0])
				uniqueMatches.push(item)
			}
		})
		uniqueMatches.sort((a, b) => b[0].length - a[0].length)
		uniqueMatches.forEach(item => {
			const [match, index, symbol] = item
			const source = match[index] === '(' ? match.slice(index + 1) : match.slice(index)
			if (!source.length) {
				return
			}
			const desti = this.getUrlReplacement(ctx, res, item)
			const newStr = match.replace(source, symbol + desti)
			res.data = res.data.replaceAll(match, newStr)
		})
		return res.data
	}

	appendScript (ctx, res) {
		const { site, interceptLog } = this.config
		const { disableJump = this.config.disableJump, confirmJump = this.config.confirmJump } = ctx.meta
		const { proxyType, base, target } = ctx.meta
		const { data } = res
		const code = `
		<script>
			(function () {
				window.webvpn = {
					site: '${site.href}',
					siteHostname: '${site.hostname}',
					siteOrigin: '${site.origin}',
					sitePathname: '${site.pathname}',
					base: '${base}',

					targetUrl: '${target.href}',

					proxyType: '${proxyType}',
					interceptLog: ${interceptLog},
					disableJump: ${disableJump},
					confirmJump: ${confirmJump}
				};

				${ctx.meta.appendCode || ''}
			})();
		</script>
		<script src="${site.origin}/public/htmlparser.js"></script>
		<script src="${site.origin}/public/html2json.js"></script>
		<script src="${site.origin}/public/append.js"></script>
		${ctx.meta.appendScriptCode || ''}
		`
		return code + data
	}

	processHtmlScopeCodes (code, url) {
		const matches = [...code.matchAll(/<script[^>]*>([\S\s]*?)<\/script>/gi)].filter(match => match[1])
		matches.sort((a, b) => b.index - a.index)
		matches.forEach(match => {
			const index = match[0].length - match[1].length - 9 + match.index
			code = code.slice(0, index) + this.refactorJsScopeCode(match[1], url) + code.slice(index + match[1].length)
		})
		return code
	}

	processJsScopeCode (code, url) {
		return this.refactorJsScopeCode(code, url)
	}

	refactorJsScopeCode (code, url) {
		const importsMatches = [
			...code.matchAll(/[\s;]import[^'"\w]*['"][^'"]+['"]/g),
			...code.matchAll(/[\s;]import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"]/g)
		]

		if (code.startsWith('import')) {
			const first = code.match(/^import[^'"\w]*['"][^'"]+['"]/) || code.match(/^import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"]/)
			if (first) {
				importsMatches.push(first)
			}
		}
		const exportsMatches = [...code.matchAll(/[\s;\}\/]export\s*\{[^}]+\}/g)]
		let noImportsExportsCode = code
		let importsCode = ''
		let exportsCode = ''
		if (importsMatches.length || exportsMatches.length) {
			const importsExportsMatches = [...importsMatches, ...exportsMatches].sort((a, b) => a.index - b.index)
			noImportsExportsCode = ''
			let left = 0
			for (let match of importsExportsMatches) {
				const diff = match[0].startsWith('import') ? 0 : 1
				noImportsExportsCode += code.slice(left, match.index + diff)
				left = match.index + 1 + match[0].length
			}
			importsCode = importsMatches.map(m => {
				return m[0].startsWith('import') ? m[0] : m[0].slice(1)
			}).join(';\n') + '\n\n'
			exportsCode = '\n\n' + exportsMatches.map(m => m[0].slice(1)).join(';\n')
		}

		const ext = this.jsExternalName
		const identifiers = this.getGlobalIdentifiers(code, url)
		const innerCode = '\n\nObject.assign(' + ext + ', {' + identifiers.join(',') + '});'
		const outerCode = '\n\n;' + identifiers.map(i => `var ${i}=${ext}.${i};`).join('')
		return importsCode + this.jsScopePrefixCode + noImportsExportsCode + innerCode + this.jsScopeSuffixCode + outerCode + exportsCode
	}

	getGlobalIdentifiers (code, url) {
		const indices = this.getBraceIndices(code)
		if (indices.length % 2) {
			console.log('00000000000000000000000000000')
			console.log(indices.length, url)
		}
		const identifiers = Array.from(new Set([
			...[...code.matchAll(/function\s+([a-zA-Z_\$][a-zA-Z0-9_\$]*)\s*\(/g)].map(m => m[1]),
			...[...code.matchAll(/class\s+([a-zA-Z_\$][a-zA-Z0-9_\$]*)\s*\{/g)].map(m => m[1]),
			...[...code.matchAll(/(var|const|let)\s+([a-zA-Z_\$][\w_\$]*)[\s=]/g)].map(m => m[2]),
			...[...code.matchAll(/[,\n]\s*([a-zA-Z_\$][\w_\$]*)\s*=[^\>=]/g)].map(m => m[1])
		]))
		return identifiers.filter(it => !this.ignoredIdentifiers.includes(it))
	}

	getBraceIndices (code) {
		const matches = [
			...code.matchAll(/[\s=!(]\/[^\/\n]+\/[gmi\s,;)]/g),
			...code.matchAll(/[\s=!(]\/(\(|\.|\)|\{|\}|\||\\\/|\w|\\|\'|\"|\[|\]|\^|\*|\?|\+|\:|\-|\@|\#)+\/[gmi\s,;)]/g)
		]
		const indexSet = new Set()
		const regexpMatches = []
		matches.forEach(match => {
			if (!indexSet.has(match.index)) {
				indexSet.add(match.index)
				regexpMatches.push(match)
			}
		})
		const regexpRanges = regexpMatches.map(m => [m.index + 1, m.index + 1 + m[0].length])

		let indices = []
		let isStr = false
		let quote = ''
		let isComment = false
		let isSingleComment = false
		let isMaybeRegexp = false

		const len = code.length
		let current = ''
		let last = ''
		for (let i = 0; i < len; i++) {
			if (regexpRanges.some(r => r[0] <= i && r[1] > i)) {
				last = code[i]
				continue
			}
			current = code[i]
			if (isStr) {
				if (current === quote) {
					if (last !== '\\' || code[i - 2] === '\\') {
						isStr = false
					}
				}
				last = current
				continue
			} else if (isComment) {
				if (isSingleComment) {
					if (current === '\n') {
						isComment = false
					}
				} else {
					if (current === '/' && last === '*') {
						isComment = false
					}
				}
				last = current
				continue
			}
			if (current === '\'' || current === '"') {
				isStr = true
				quote = current
				last = current
				continue
			}
			if (last === '/') {
				if (current === '/') {
					isComment = true
					isSingleComment = true
					isStr = false
					last = current
					continue
				} else if (current === '*') {
					isComment = true
					isSingleComment = false
					isStr = false
					last = current
					continue
				}
			}
			if (current === '{') {
				indices.push([i, true])
			} else if (current === '}') {
				indices.push([i, false])
			}
			last = current
		}

		// return indices

		if (!indices.length) {
			return indices
		}

		indices.sort((a, b) => a[0] - b[0])

		let lastCount = 0
		while (true) {
			const inner = new Set()
			for (let i = 0, len = indices.length; i < len - 1; i++) {
				if (indices[i][1] && !indices[i + 1][1]) {
					inner.add(i).add(i + 1)
					i += 1
				}
			}
			if (!inner.size) {
				break
			}
			indices = indices.filter((_, i) => !inner.has(i))
		}

		return indices
	}

	getUrlReplacement (ctx, res, item) {
		const [match, index, symbol] = item
		const { site } = this.config
		const { base, serviceHost, serviceBase, isUrlReversed, target, proxyType } = ctx.meta
		const source = match.slice(index)
		let suffix = match.slice(index + 1)
		if (suffix.indexOf('&amp;') >= 0) {
			suffix = suffix.replaceAll('&amp;', '&')
		}
		if (suffix.indexOf('&#x') >= 0) {
			suffix = unescape(suffix.replaceAll('&#x', '%').replaceAll(';', ''))
		}
		suffix = suffix.replaceAll(/\\\//g, '/')

		if (suffix.startsWith('//')) {
			suffix = target.protocol + suffix
		}

		let isValidUrl = suffix.startsWith('http')

		suffix = suffix.replace(/^\.\//, '').replaceAll(/\/\.\//g, '')
		if (!isValidUrl) {
			const { origin, pathname } = ctx.meta.target
			if (suffix[0] === '/') {
				suffix = origin + suffix
			} else {
				suffix = origin + base + suffix
			}
			isValidUrl = true
		}
		if (suffix.indexOf('../') > 0) {
			suffix = new URL(suffix).href
		}

		let desti = (suffix[0] === '/' ? serviceHost : (serviceBase + '/')) + suffix

		if (isValidUrl) {
			let u = null
			try {
				u = new URL(suffix)
			} catch {
				console.log(chalk.red('eeeeeeeeeeeeeeeeee'))
				console.log(match)
				return match
			}
			if (proxyType === 'single' && target.hostname !== u.hostname) {
				return source
			}
			desti = site.pathname + '/' + proxyType + '/'
			if (isUrlReversed) {
				desti += u.origin
			} else {
				desti += encodeURIComponent(u.origin)
			}
			desti += suffix.slice(u.origin.length).replace('%22', '"')
		}

		if (isUrlReversed) {
			const quotationMarks = `'"`
			const qm = quotationMarks[quotationMarks.indexOf(source.slice(-1))] || ''
			if (qm) {
				desti = desti.slice(0, -1)
			}
			desti = desti.replaceAll('%', '%25')
			desti = this.encodeReplacementUrl(desti) + qm
		}
		return desti
	}

	encodeReplacementUrl (url) {
		const parts = url.split('/')
		const index = url.startsWith('/proxy/') && 3 || 5
		const prefix = parts.slice(0, index).join('/')
		const suffix = this.encodeUrl(parts.slice(index).join('/'))
		return prefix + (suffix ? ('/' + suffix) : '')
	}

	processOthers (ctx, res) {
		if (ctx.meta.mime === 'json' && typeof res.data === 'string') {
			res.data = JSON.stringify(res.data)
		}
	}

	getSuffixMime (ctx) {
		return this.mimes.find(mime => ctx.url.endsWith('??' + mime))
	}

	initCtxUrl (ctx) {
		const parts = ctx.url.split('?')
		if (parts[0].indexOf('ptth') > 0) {
			ctx.meta.isUrlReversed = true
			ctx.url = this.decodeCtxUrl(parts[0])
			if (parts[1]) {
			 	ctx.url += '?' + parts[1]
			}
		} else {
			ctx.meta.isUrlReversed = false
		}
		ctx.url = ctx.url.replaceAll(/\\\//g, '/')
		if (ctx.meta.suffixMime) {
			ctx.url = ctx.url.slice(0, -(ctx.meta.suffixMime.length + 2))
		}
	}

	initUrlMeta (ctx) {
		const parts = ctx.url.split('/')
		let proxyType = 'all'
		let url = ''
		if (parts[1] !== 'proxy' && parts[1] !== 'public' && ctx.headers['referer']) {
			url = new URL(decodeURIComponent(this.decodeUrl(ctx.headers['referer'].split('/proxy/all/')[1]))).origin + ctx.url
		} else {
			proxyType = parts[2]
			const index = ctx.url.startsWith('/proxy') ? 3 : 2
			let targetStr = decodeURIComponent(parts[index])
			while (true) {
				try {
					new URL(targetStr)
					break
				} catch {
					// TODO 不要过度 decodeURIComponent，需要检查下链接里的 % 是不是合规
					if (targetStr.indexOf('%') >= 0) {
						try {
							targetStr = decodeURIComponent(targetStr)
						} catch {
							console.log(chalk.red('dddddddddddddddddd'))
							console.log(targetStr)
							return false
						}
					} else {
						return false
					}
				}
			}
			url = targetStr
			if (parts.length > 4) {
				url += '/' + parts.slice(4).join('/')
			}
			url = url.replaceAll('%25', '%')
		}
		const target = new URL(url)
		// 这里需要使用 decodeURIComponent 多次的 targetStr 进行 encodeURIComponent
		// 不能用 parts[3], 不然字符串里会出现多个 %25
		let serviceHost = [this.config.site.pathname, proxyType, encodeURIComponent(url)].join('/')
		if (serviceHost.startsWith('//')) {
			serviceHost = serviceHost.slice(1)
		}
		let serviceBase = serviceHost
		const pathnameParts = target.pathname.split('/')
		if (pathnameParts.length >= 3) {
			serviceBase = [serviceHost, ...pathnameParts.slice(1, -1)].join('/')
		}

		url = this.escapeUrl(url)
		url = url.replaceAll('./', '')

		Object.assign(ctx.meta, {
			url,
			mime: ctx.meta.suffixMime || this.getResponseType(ctx, url),
			proxyType,
			serviceHost,
			serviceBase,
			target
		})

		return true
	}

	setRedirectedUrlMeta (ctx, url) {
		const target = new URL(url)
		const serviceHost = [this.config.site.pathname, ctx.meta.proxyType, encodeURIComponent(target.origin)].join('/')
		let serviceBase = serviceHost
		const pathnameParts = target.pathname.split('/')
		if (pathnameParts.length >= 3) {
			serviceBase = [serviceHost, ...pathnameParts.slice(1, -1)].join('/')
		}
		Object.assign(ctx.meta, {
			url,
			mime: ctx.meta.suffixMime || this.getResponseType(ctx, url),
			serviceHost,
			serviceBase,
			target
		})
	}

	escapeUrl (url) {
		if (/[\u0100-\uffff]/.test(url)) {
			return encodeURI(url)
		}
		const chars = ' <>{}|\\^~[]‘@$'
		for (let char of chars) {
			if (url.indexOf(char) >= 0) {
				return encodeURI(url)
			}
		}
		return url
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

	processCookies (ctx) {
		const cookie = ctx.headers['cookie']
		if (!cookie) {
			return
		}
		const { hostname } = ctx.meta.target
		const kvs = cookie.split('; ').filter(kv => {
			return kv.startsWith(hostname)
		}).map(kv => kv.slice(hostname.length + 2))
		ctx.headers['cookie'] = kvs.join('; ')
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
			headers['set-cookie'] = res.headers.getAll('set-cookie')
		} else {
			headers = res.headers
			headers['set-cookie'] = headers['set-cookie'] || []
		}
		const { hostname } = ctx.meta.target
		headers['set-cookie'] = headers['set-cookie'].map(cookie => {
			return hostname + '::' + cookie.replace(/HttpOnly/i, '')
		})
		if (headers['access-control-allow-origin'] && headers['access-control-allow-origin'] !== '*') {
			headers['access-control-allow-origin'] = this.config.site.origin
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

	encodeUrl (url) {
		return encodeURIComponent(this.reverseText(url))
	}

	decodeCtxUrl (url) {
		const index = url.startsWith('/proxy') ? 3 : 2
		const parts = url.split('/')
		const prefix = parts.slice(0, index).join('/')
		const isEncoded = url.indexOf('//') < 0
		const suffix = this.decodeUrl(parts.slice(index).join(isEncoded ? '' : '/'))
		return prefix + '/' + suffix
	}

	decodeUrl (url) {
		url = url ? url.trim() : ''
		if (!url || url === '/') {
			return url
		}
		url = decodeURIComponent(url)
		if (url.endsWith('ptth')) {
			url = this.reverseText(url)
		} else {
			const [prefix, suffix] = url.split('ptth')
			url = this.reverseText(prefix + 'ptth') + suffix
		}
		let u = null
		try {
			u = new URL(url)
		} catch {
			return url
		}
		return encodeURIComponent(u.origin) + url.slice(u.origin.length)
	}

	getMatchUrl (match) {
		if (match.startsWith('http')) {
			return match
		}
		let parts = match.split(/('|")/)
		if (parts.length > 1) {
			return parts[2]
		}
		parts = match.split('(')
		if (parts.length > 1) {
			return parts[1]
		}
		return match
	}

	checkLogUrlError (ctx) {
		let ok = !/\.(min|js|css)?.*\.map/.test(ctx.url)
		ok = ok && ctx.url !== '/favicon.ico'
		return ok
	}

	setOriginHeaders (ctx, headers) {
		const { host, origin, href } = ctx.meta.target
		Object.assign(headers, { host, origin, referer: href })
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

	processInvalidUrl (ctx) {
		return false
	}

	shouldReplaceUrls (ctx, res) {
		return true
	}

	chinease2Unicode (ctx, res) {
		const text = res.data
		if (!text) {
			return ''
		}
		let unicode = ''
		for (let i = 0; i < text.length; i++) {
			const temp = text.charAt(i)
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

	reverseText (text) {
		return text.split('').reverse().join('')
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
