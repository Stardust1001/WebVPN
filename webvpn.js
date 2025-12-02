import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import cluster from 'node:cluster'
import { ZSTDDecompress } from 'simple-zstd'
import chalk from 'chalk'
import Koa from 'koa'
import WebSocket, { WebSocketServer } from 'ws'
import fetch, { File, FormData } from 'node-fetch'
import iconv from 'iconv-lite'

import { fsUtils, Storage } from '@wp1001/node'

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

const sharedSessions = new Storage({ filepath: './shared-sessions.json', autoLoad: true, autoSave: false })
setInterval(async () => {
  const cache = { ...sharedSessions.cache }
  await sharedSessions.load()
  await sharedSessions.save({ ...sharedSessions.cache, ...cache })
}, 10e3)

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
      [/\.wasm/i, 'wasm'],
      [/\.(png|jpg|ico|svg|gif|webp|jpeg)/i, 'image'],
      [/\.(mp4|m3u8|ts|flv)[^a-zA-Z]/i, 'video'],
      [/\.(mp3|wav|ogg)/i, 'audio'],
      [/\.(pdf|csv|tsv|doc|docx|xls|xlsx|ppt|pptx)/i, 'pdf-office'],
      [/\.(html|php|do|asp|htm|shtml)/i, 'html'],
      [/\.(ttf|eot|woff|woff2)/i, 'font']
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
      'stream': 'application/octet-stream, application/protobuffer',
      'event-stream': 'text/event-stream'
    }
    this.jsKeywords = [
      'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finaly', 'for',
      'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try',
      'typeof', 'var', 'void', 'while', 'with',
      'boolean', 'byte', 'char', 'class', 'const', 'debugger', 'double', 'enum', 'export',
      'extends', 'final', 'float', 'goto', 'implements', 'import', 'int', 'interface', 'long',
      'native', 'package', 'private', 'protected', 'public', 'short', 'static', 'super',
      'synchronized', 'throws', 'transient', 'volatile'
    ]
    this.ignoreRequestHeaderRegexps = [
      /^x-(forwarded|requested|csrf|content|frame)/i,
      /upgrade-insecure-requests/i
    ]
    this.ignoreResponseHeaderRegexps = [
      /content-length/i,
      /x-content-type-options/i,
      /report-to/i,
      /x-xss-protection/i,
      /cross-origin-resource-policy/i,
      /cross-origin-opener-policy/i,
      /cross-origin-embedder-policy/i,
      /content-security-policy-report-only/i,
    ]

    this.noTransformMimes = ['wasm', 'font', 'json', 'image', 'video', 'audio', 'pdf-office', 'event-stream']
    this.cacheMimes = ['js', 'css', 'font', 'image', 'video', 'audio', 'pdf-office']
    this.cacheDir = config.cacheDir || 'cache'

    this.checkCaches()

    this.jsInterceptCode = fs.readFileSync('./public/intercept.js')

    this.convertDomainsCode = `
      const vpnDomain = '${config.vpnDomain}'
      const subdomains = ${JSON.stringify(config.subdomains)}
      const domainDict = {}
      Object.entries(subdomains).forEach(([sub, name]) => domainDict[name] = sub)
      globalThis.encodeHost = text => domainDict[text] || text.replace(':', '_._')
      globalThis.decodeHost = text => subdomains[text] || text.replace(vpnDomain, '').replace('_._', ':')
    `
    eval(this.convertDomainsCode)

    this.jsWorkerContextCode = `
      // worker 里面创造 __context__ 环境
      if (!self.window) {
        ${this.convertDomainsCode}
        setTimeout = self.setTimeout.bind(self)
        const _importScripts  = self.importScripts
        self.importScripts = function (...props) {
          props = props.map(transformUrl)
          return _importScripts.apply(self, props)
        }
        const target = new URL('#targetUrl#')
        const site = new URL('#siteUrl#')
        function transformUrl (url) {
          url = (url ? url.toString() : '').trim()
          if (url.startsWith('//')) {
            url = target.protocol + url
          }
          const u = new URL(url)
          if (u.hostname.includes(vpnDomain)) return url
          const subdomain = encodeHost(u.host)
          return url.replace(u.origin, site.origin.replace('www', subdomain))
        }

        self.webvpn = { target, site, transformUrl }
        const globalCons = ['self', 'globalThis']
        const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']

        self.__location__ = {}
        locationAttrs.forEach(key => {
          self.location['__' + key + '__'] = webvpn.target[key]
          for (let i = 0; i < 2; i++) {
            if (i) key = '__' + key + '__'
            Object.defineProperty(self.__location__, key, {
              get () {
                key = key.replaceAll('__', '')
                return webvpn.target[key] || location[key]
              }
            })
          }
        })
        self.__location__.toString = () => self.__location__.href

        for (const con of globalCons) {
          if (con === 'globalThis') {
            self['__' + con + '__'] = self.__self__
            continue
          }
          self['__' + con + '__'] = new Proxy(self[con], {
            get (target, property, receiver) {
              if (globalCons.includes(property) || property === 'location') {
                return self['__' + property + '__']
              }
              const value = target[property]
              return (typeof value === 'function' && !value.prototype) ? value.bind(target) : value
            },
            set (target, property, value) {
              if (['globalThis', 'self', 'location'].includes(property)) {
                return false
              }
              target[property] = value
              return true
            }
          })
        }
        self.__context__ = {
          self: self.__self__,
          globalThis: self.__globalThis__,
          location: self.__location__
        }
        self.__context_proxy__ = new Proxy(self.__context__, {
          has (target, prop) {
            return true
          },
          get (target, prop) {
            return prop in target ? target[prop] : self[prop]
          },
          set (target, prop, value) {
            self[prop] = value
            return value
          }
        })

        const fetch = self.fetch
        self.fetch = function (input, init) {
          if (input instanceof URL) input = input.href
          const isInputUrl = typeof input === 'string'
          const url = isInputUrl ? input : input.url
          const newUrl = transformUrl(url)
          if (isInputUrl) {
            input = newUrl
          } else {
            const init = {}
            for (let key in input) {
              const value = input[key]
              if (key === 'url' || typeof value === 'function') continue
              init[key] = value
            }
            input = new Request(newUrl, init)
          }
          return fetch.apply(self, [input, init])
        }
      }
    `
    this.jsScopePrefixCode = `
    (function () {
      atob = self.atob.bind(self)
      addEventListener = self.addEventListener.bind(self)
      postMessage = self.postMessage.bind(self)
      with (self.__context_proxy__) {
    `
    this.jsScopeSuffixCode = `
    }).call(self.__context__.self)
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
    } else if (ctx.url.startsWith('/share-sessions')) {
      if (ctx.method === 'POST') {
        const body = await this.calcRequestBody(ctx)
        sharedSessions.setItem(ctx.query.shareId + '-clientCache', body)
      }
      return ctx.res.writeHead(200, {
        'access-control-allow-credentials': true,
        'access-control-allow-origin': ctx.headers['origin'] || '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*'
      })
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
    app.use(this.proxyRoute.bind(this))

    const server = http.createServer({}, app.callback())

    this.wsServer = new WebSocketServer({ server })
    this.wsServer.onConnection = async (client, request) => {
      let { host, origin } = request.headers
      if (host) host = this.convertHost(host)
      const protocol = origin && !origin.startsWith('https') ? 'http' : 'https'
      const url = protocol + '://' + host + (request.url || '')

      const wsClient = new WebSocket(url)
      await new Promise(resolve => {
        wsClient.on('open', resolve)
      })
      wsClient.on('message', message => {
        message = message.toString()
        client.send(message)
      })
      wsClient.on('close', () => {
        client.close()
      })

      client.on('message', message => {
        message = message.toString()
        wsClient.send(message)
      })
      client.on('close', () => {
        wsClient.close()
      })
    }

    server.listen(config.port)

    if (config.httpsEnabled) {
      const options = {
        key: fs.readFileSync('ssl/server.key'),
        cert: fs.readFileSync('ssl/server.pem')
      }
      https.createServer(options, app.callback()).listen(config.httpsPort)
    }
  }

  async proxyRoute (ctx, next) {
    if (ctx.headers.upgrade === 'websocket') {
      this.wsServer.handleUpgrade(ctx.request, ctx.socket, ctx.headers, client => {
        this.wsServer.onConnection(client, ctx.request)
      })
    }
    ctx.scheme = new URL(ctx.request.href).protocol.slice(0, -1)
    const subdomain = ctx.headers.host.replace(this.config.vpnDomain, '')
    if (subdomain === 'www') {
      return await this.serveWww(ctx)
    } else if (subdomain === this.config.vpnDomain.slice(1)) {
      ctx.res.writeHead(302, {
        location: ctx.scheme + '://' + this.config.site.host
      })
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

    if (ctx.headers.accept === 'text/event-stream') {
      return await this.respondPipe(ctx)
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

    if (ctx.meta.mime === 'html') {
      const firstChar = res.data[0]
      const lastChar = res.data[res.data.length - 1]
      if (
        firstChar === '[' && lastChar === ']'
        || firstChar === '{' && lastChar === '}'
      ) {
        ctx.meta.mime = 'json'
        ctx.meta.done = true
      } else if (!/<[a-zA-Z]+/.test(res.data)) {
        ctx.meta.mime = 'text'
        ctx.meta.done = true
      }
    }

    if (!ctx.meta.done && (await this.afterRequest(ctx, res))) {
      return
    }

    if (!ctx.meta.done && res.data && this.shouldReplaceUrls(ctx, res)) {
      this.replaceUrls(ctx, res)
      this.customResponse(ctx, res)
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

    if (!ctx.meta.done && this.beforeResponse(ctx, res)) {
      return
    }

    this.setCache(ctx, res)

    ctx.body = res.data
  }

  routeInit (ctx) {
    const { isMainSession, shareId } = this.checkShareSession(ctx)
    const domain = decodeHost(ctx.subdomain)
    const url = ctx.scheme + '://' + domain + ctx.url
    ctx.meta = {
      shareId,
      isMainSession,
      url,
      mime: this.getResponseType(ctx, url),
      scheme: ctx.scheme,
      target:  new URL(url),
      host: ctx.headers['host'],
      origin: ctx.headers['origin'],
      referer: ctx.headers['referer']
    }
  }

  checkShareSession (ctx) {
    let isMainSession = false, shareId = ''
    if (!ctx.subdomain.includes('.') && ctx.subdomain.includes('-')) {
      const parts = ctx.subdomain.split('-')
      ctx.subdomain = parts[0]
      isMainSession = parts[1] === 'main'
      shareId = parts[2]
      const shareSuffix = '-' + parts.slice(1).join('-')
      for (let key of ['host', 'origin', 'referer']) {
        if (ctx.headers[key]) {
          ctx.headers[key] = ctx.headers[key].replace(shareSuffix, '')
        }
      }
      if (isMainSession) {
        if (ctx.headers['cookie']) {
          sharedSessions.setItem(shareId + '-cookie', ctx.headers['cookie'])
        }
        if (ctx.headers['authorization']) {
          sharedSessions.setItem(shareId + '-authorization', ctx.headers['authorization'])
        }
      } else {
        const cookie = sharedSessions.getItem(shareId + '-cookie')
        const authorization = sharedSessions.getItem(shareId + '-authorization')
        if (cookie) ctx.headers['cookie'] = cookie
        if (authorization) ctx.headers['authorization'] = authorization
      }
    }
    for (let key of ['origin', 'referer']) {
      if (ctx.headers[key]?.includes('-')) {
        const subdomain = new URL(ctx.headers[key]).hostname.split('.')[0]
        if (subdomain.includes('-')) {
          ctx.headers[key] = ctx.headers[key].replace('-' + subdomain.split('-').slice(1).join('-'), '')
        }
      }
    }
    return { isMainSession, shareId }
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
      url: ctx.meta.url,
      method,
      protocol,
      hostname,
      headers,
      path: ctx.meta.url.slice(protocol.length + 2 + hostname.length + (port ? port.length + 1 : 0)),
      port: port * 1 || (isHttps ? 443 : 80)
    }
    if (isHttps && !options.agent) {
      options.agent = httpsAgent
    }
    if (await this.beforeRequest(ctx, options)) {
      return
    }
    await new Promise(resolve => {
      const lib = isHttps ? https : http
      const req = lib.request(options, res => {
        const headers = this.initResponseHeaders(ctx, res)
        this.deleteIgnoreHeaders(this.ignoreResponseHeaderRegexps, headers)
        ctx.res.writeHead(res.statusCode, headers)
        res.pipe(ctx.res)
        res.on('end', resolve)
      })
      req.on('error', err => {
        ctx.res.writeHead(500)
        ctx.body = err
      })
      req.end()
    })
  }

  async request (ctx) {
    const { method, header } = ctx.request
    this.deleteIgnoreHeaders(this.ignoreRequestHeaderRegexps, header)
    this.setOriginHeaders(ctx, header)

    const options = {
      url: ctx.meta.url,
      method,
      headers: header,
      redirect: 'manual',
      ...this.getRequestOptions(ctx)
    }
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      options.body = await this.calcRequestBody(ctx)
    }
    const result = await this.beforeRequest(ctx, options)
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

  async calcRequestBody (ctx) {
    const hasFile = ctx.headers['content-type']?.includes('multipart/form-data; boundary')
    let body = hasFile ? [] : ''
    await new Promise(resolve => {
      ctx.req.on('data', chunk => {
        if (hasFile) {
          body.push(...chunk)
        } else {
          body += chunk
        }
      })
      ctx.req.on('end', resolve)
    })
    if (hasFile) {
      const formData = new FormData()
      formData.append(undefined, new File([new Uint8Array(body)], undefined, {}))
      body = formData
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
      if (headers['content-encoding']?.includes('gzip')) {
        delete headers['content-encoding']
      }
      ctx.meta.done = true
      if (ctx.meta.mime === 'json') {
        delete headers['content-encoding']
        data = await res.text()
        if (data === '') data = '{}'
        return {
          status: res.status,
          data,
          headers
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
    return [...new Set(res.data.match(/\s(href|src|action|srcset|poster)=(\"|\')?(http\:|https\:|http\%3A|https\%3A|\/\/)[^\s\>]*/g))]
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
    matches.filter(m => !m.includes('\n') && m.indexOf(vpnDomain) < 0).forEach(match => {
      let url = ''
      let prefix = ''
      let quote = ''
      if (match.slice(0, match.indexOf('//')).indexOf('http') >= 0) {
        url = match.slice(match.indexOf('http'), -1)
        prefix = match.indexOf('https') > 0 ? 'https://' : 'http://'
      } else {
        url = ctx.meta.scheme + ':' + match.slice(match.indexOf('//'), -1)
        quote = match[match.indexOf('//') - 1]
        prefix = '//'
      }
      const u = url.slice(url.indexOf('//') + 2)
      if (!u || !/[\w]+\./.test(u)) return
      if (/&#x\w+;/.test(url)) {
        url = url.replaceAll(/&#x\w+;/g, ele => String.fromCharCode(parseInt(ele.slice(3, -1), 16)))
      }
      if (url.includes('"')) {
        url = url.replaceAll('"', '')
      }
      const source = prefix + new URL(url).host
      const value = this.transformUrl(ctx, source.startsWith('http') ? source : (ctx.meta.scheme + ':' + source))
      dict[quote + source] = quote + value
    })
    Object.entries(dict).sort((a, b) => b[0].length - a[0].length).forEach(ele => {
      const [key, value] = ele
      res.data = res.data.replaceAll(key, value)
    })
    return res.data
  }

  transformUrl (ctx, url) {
    const { httpsEnabled, site } = this.config
    const u = new URL(url)
    const subdomain = encodeHost(u.host)
    const protocol = httpsEnabled ? u.protocol : 'http:'
    return url.replace(u.origin, (protocol + '//' + site.host).replace('www', subdomain))
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
        isScript = type.indexOf('javascript') >= 0
        if (
          !isScript
          && type.indexOf('text/') < 0
          && !type.includes('json')
        ) {
          isScript = true
        }
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
    if (code[0] === '{' || code[0] === '[') {
      try {
        JSON.parse(code)
        ctx.meta.mime = 'json'
        return code
      } catch {}
    }
    return this.refactorJsScopeCode(ctx, code, true)
  }

  refactorJsScopeCode (ctx, code, isJsFile = false) {
    const { httpsEnabled, site } = this.config
    const { scheme, target } = ctx.meta
    const prefix = site.origin.slice(site.origin.indexOf('//'))
    const siteUrl = (httpsEnabled ? scheme : 'http') + ':' + prefix
    return (isJsFile ? this.jsWorkerContextCode.replace('#targetUrl#', target.href).replace('#siteUrl#', siteUrl) : '')
            + this.jsScopePrefixCode
            + code
            + '\n}\n'
            + this.calcHoistIdentifiersCode(code)
            + this.jsScopeSuffixCode
  }

  calcHoistIdentifiersCode (code) {
    const matches = [...code.matchAll(/(function|class)\s+([\$\_\w]+)\s*\(/g)]
    if (!matches.length) return ''
    const names = matches.map(m => m[2]).filter(k => !this.jsKeywords.includes(k))
    return names.map(n => `try { self.${n} = ${n}; } catch {}`).join('\n')
  }

  appendScript (ctx, res) {
    const { httpsEnabled, site, interceptLog, debug, pluginsEanbled } = this.config
    const { disableJump = this.config.disableJump, confirmJump = this.config.confirmJump } = ctx.meta
    const { base, scheme, target, isMainSession, shareId, appendCode, initInterceptionCode, appendScriptCode } = ctx.meta
    const { data } = res
    const prefix = site.origin.slice(site.origin.indexOf('//'))
    const siteUrl = (httpsEnabled ? scheme : 'http') + ':' + prefix
    const pageUrl = this.transformUrl(ctx, target.href)
    const code = `
    <script>
      self.webvpn = {
        siteUrl: '${siteUrl}',
        protocol: '${scheme}:',
        sourceUrl: '${target.href}',
        pageUrl: '${pageUrl}',
        hostname: '${target.hostname}',
        base: '${base}',
        interceptLog: ${interceptLog},
        disableJump: ${disableJump},
        confirmJump: ${confirmJump},
        isMainSession: ${isMainSession},
        shareId: '${shareId}',
      };
      ${appendCode || ''}
      ${this.convertDomainsCode || ''}
      ${initInterceptionCode || ''}
      webvpn.append_code = ${JSON.stringify(this.jsInterceptCode.toString())}
      eval(webvpn.append_code)
      self.webvpn.workerWrapperCode = \`
        ${this.jsWorkerContextCode.replace('#siteUrl#', siteUrl)}
        ${this.jsScopePrefixCode}
          #CODE#
        }
        ${this.jsScopeSuffixCode}
      \`
    </script>
    ${
      pluginsEanbled
      ?
      `<script src="${prefix}/public/plugins.js"></script>`
      : ''
    }
    ${
      debug
      ? `
        <script src="https://cdnjs.cloudflare.com/ajax/libs/vConsole/3.15.1/vconsole.min.js"></script>
        <script>new VConsole()</script>
      `
      : ''
    }
    ${
      isMainSession
      ?
      `<script src="${prefix}/public/share-sessions.js"></script>`
      : ''
    }
    ${
      !isMainSession && shareId
      ?
      `<script>
        const { cookie, localStorage: local } = ${sharedSessions.getItem(shareId + '-clientCache') || '{}'}
        document.cookie += cookie
        localStorage.clear()
        for (let key in local) localStorage[key] = local[key]
      </script>`
      : ''
    }
    <script>
      const ss = Array.from(document.querySelectorAll('script'));
      ss.forEach(script => script.remove());
    </script>
    ${appendScriptCode || ''}
    `
    const hasDoctype = /^\s*?\<\!DOCTYPE html\>/i.test(res.data)
    return (hasDoctype ? '<!DOCTYPE html>\n' : '') + code + data
  }

  processOthers (ctx, res) {
    if (ctx.meta.mime === 'json' && typeof res.data === 'string') {
      res.data = JSON.stringify(res.data)
    }
    if (this.config.disableSourceMap) {
      if (ctx.meta.mime === 'html' || ctx.meta.mime === 'js') {
        res.data = res.data.replaceAll('sourceMappingURL', '')
      }
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

  getRequestOptions (ctx) {
    const config = { }
    if (ctx.meta.mime === 'image') {
      config.responseType = 'arraybuffer'
    }
    return config
  }

  initResponseHeaders (ctx, res) {
    let headers = {}
    if (typeof res.headers.raw === 'function') {
      const raw = res.headers.raw()
      for (let key in raw) {
        headers[key.toLowerCase()] = raw[key]
      }
    } else {
      for (let key in res.headers) {
        const value = res.headers[key]
        headers[key.toLowerCase()] = Array.isArray(value) ? value : [value]
      }
    }
    if (headers['access-control-allow-origin']) {
      headers['access-control-allow-origin'] = headers['access-control-allow-origin'].map(e => {
        if (e === '*') return e
        const host = e.indexOf('http') >= 0 ? new URL(e).host : e
        return e.replace(host, encodeHost(host) + this.config.vpnDomain)
      })
    }
    headers['content-type'] = [headers['content-type']?.[0] || 'text/html']
    if (headers['content-security-policy']) {
      headers['content-security-policy'] = headers['content-security-policy'].map(e => {
        if (
          e.includes('-src')
          || e.includes('unsafe-')
          || e.includes('require-trusted-types-for')
        ) return ''
        if (e.indexOf('frame-ancestors') < 0 || e === `frame-ancestors 'none';`) return e
        const protocol = (this.config.httpsEnabled ? ctx.meta.scheme : 'http') + '://'
        return e.replace(
          'frame-ancestors',
          'frame-ancestors ' + protocol + this.config.site.host.replace('www', '*')
        )
      })
    }
    if (headers['location']) {
      headers['location'] = headers['location'].map(e => {
        if (!e.startsWith('http')) {
          if (e[0] === '/') {
            e = ctx.meta.target.origin + e
          }
        }
        return this.transformUrl(ctx, e)
      })
    }
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(e => {
        e = e.replace(' Secure;', '')
        if (!/domain=/i.test(e)) return e
        return e.split('; ').map(p => {
          if (!/domain=/i.test(p)) return p
          return 'domain=' + this.config.vpnDomain
        }).join('; ')
      })
    }
    if (!headers['access-control-allow-origin']) {
      headers['access-control-allow-origin'] = ['*']
    }
    if (this.config.httpsEnabled && ctx.meta.scheme === 'https') {
      if (!headers['content-security-policy']) {
        headers['content-security-policy'] = []
      }
      headers['content-security-policy'].push('upgrade-insecure-requests')
    }
    headers['x-frame-options'] = ['allowall']
    if (!ctx.meta.isMainSession && ctx.meta.shareId) {
      const cookie = sharedSessions.getItem(ctx.meta.shareId + '-cookie')
      if (cookie) headers['set-cookie'] = cookie
    }
    return headers
  }

  getMimeByResponseHeaders (headers) {
    const contentType = headers['content-type']?.[0] || ''
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
    return decodeHost(host.replace(this.config.vpnDomain, ''))
  }

  async convertCharsetData (ctx, headers, res) {
    if (ctx.meta.mime !== 'html' && ctx.meta.mime !== 'js') {
      return res.text()
    }
    let text, buffer
    if (res.headers.get('content-encoding') === 'zstd') {
      res.headers.delete('content-encoding')
      text = await new Promise(resolve => {
        let body = ''
        const stream = res.body.pipe(ZSTDDecompress())
        stream.on('data', chunk => body += chunk)
        stream.on('end', () => resolve(body))
      })
    } else {
      buffer = Buffer.from(await res.arrayBuffer())
      text = iconv.decode(buffer, 'utf-8')
    }
    let contentType = headers['content-type']?.[0] || ''
    let charset = contentType.split('charset=')[1]?.toLowerCase()
    if (!charset) {
      let match = text.match(/<meta charset=[\"\'][^"'\/>]+/)
      if (!match) {
        match = text.match(/<meta http-equiv=\"Content-Type\" content=\"text\/html;\s*charset=[^"'\/>]+/i)
      }
      if (!match) {
        return text
      }
      charset = match[0].split('charset=')[1].replaceAll('"', '').toLowerCase()
      contentType = 'text/html; charset=' + charset
    }
    if (charset === 'utf-8' || charset === 'utf8') {
      return text
    }
    headers['content-type'] = [contentType.replace(charset, 'utf-8')]
    if (buffer) {
      text = iconv.decode(buffer, charset)
      text = text.replace(/<meta charset="\w+">/, '<meta charset="utf-8">')
    }
    return text
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

  beforeRequest (ctx, options) { }

  afterRequest (ctx, res) { }

  customResponse (ctx, res) {
    // 禁用 module 和严格模式，以支持 with 语句
    if (typeof res.data === 'string') {
      res.data = res.data.replaceAll('type="module"', 'type="mod"')
                .replaceAll('type=module', 'type=mod')
                .replaceAll('nomodule', 'nomod')
                .replaceAll(' integrity', ' no-integrity')
                .replaceAll('use strict', '')
                .replace(/[\s\{\}\;]?with\s*\(\s*this\s*\)/g, ' with(this === self ? __self__ : this)')
                // 这个替换并不优雅，也不完整，有问题就取消
                .replace(/location\.(hostname|host|origin|href|protocol|navigate|assign|replace|reload|toString)/g, 'location.__$1__')
    }
  }

  beforeResponse (ctx, res) { }
}

export default WebVPN
