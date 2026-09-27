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

import { fsUtils } from '@wp1001/node'

// rewriteThis 开启时才需要 acorn + magic-string，用动态 import 懒加载避免影响默认路径
let _acornPromise
function getAcorn () {
  if (!_acornPromise) _acornPromise = import('acorn').then(m => m.default || m)
  return _acornPromise
}
let _magicStringPromise
function getMagicString () {
  if (!_magicStringPromise) _magicStringPromise = import('magic-string').then(m => m.default || m)
  return _magicStringPromise
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

const globalCache = {
  cache: {},
  ttl: 30 * 60 * 1000,
  maxItems: 10000,
  getItem (key) {
    const item = globalCache.cache[key]
    if (!item) return undefined
    if (item.expires && Date.now() > item.expires) {
      delete globalCache.cache[key]
      return undefined
    }
    return item.value
  },
  setItem (key, value) {
    // 防止恶意客户端生成大量 shareId 导致内存无限增长：
    // 超过上限时淘汰最早写入的条目（近似 FIFO，已过期条目优先清理）
    const cache = globalCache.cache
    if (Object.keys(cache).length >= globalCache.maxItems) {
      let oldestKey = null
      let oldestTime = Infinity
      for (const k in cache) {
        const t = cache[k].expires
        if (t < oldestTime) {
          oldestTime = t
          oldestKey = k
        }
      }
      if (oldestKey) delete cache[oldestKey]
    }
    cache[key] = { value, expires: Date.now() + globalCache.ttl }
    if (!cluster.isMaster) {
      process.send({ workerId: process.pid, action: 'setCache', key, value })
    }
  },
  syncItem (key, value) {
    globalCache.cache[key] = { value, expires: Date.now() + globalCache.ttl }
  }
}

class WebVPN {
  constructor (config) {
    const { port, httpsPort, site } = config
    // 去掉前导 www. 标签，保留前导点（vpnDomain 用于子域后缀拼接，如 //www + vpnDomain）
    config.vpnDomain = '.' + site.hostname.replace(/^www\./, '')
    config.httpVpnDomain = config.vpnDomain + (port === 80 ? '' : `:${port}`)
    config.httpsVpnDomain = config.vpnDomain + (httpsPort === 443 ? '' : `:${httpsPort}`)

    this.config = config
    this.mimes = ['json', 'js', 'css', 'html', 'image', 'video', 'audio']
    this.mimeRegs = [
      [/\.json(?:$|#)/i, 'json'],
      [/\.js(?:$|#)/i, 'js'],
      [/\.css(?:$|#)/i, 'css'],
      [/\.wasm(?:$|#)/i, 'wasm'],
      [/\.(?:png|jpg|ico|svg|gif|webp|jpeg)(?:$|#)/i, 'image'],
      [/\.(?:mp4|m3u8|ts|flv)(?:$|#)/i, 'video'],
      [/\.(?:mp3|wav|ogg)(?:$|#)/i, 'audio'],
      [/\.(?:pdf|csv|tsv|doc|docx|xls|xlsx|ppt|pptx)(?:$|#)/i, 'pdf-office'],
      [/\.(?:html|php|do|asp|htm|shtml)(?:$|#)/i, 'html'],
      [/\.(?:ttf|eot|woff|woff2)(?:$|#)/i, 'font']
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
      'pdf-office': 'application/pdf',
      'stream': 'application/octet-stream, application/protobuffer',
      'event-stream': 'text/event-stream'
    }
    this.jsKeywords = [
      'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for',
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

    // 预编译热路径正则表达式，避免每次请求重复编译
    this.reBase = /\<base\s+href=("|')[^"'']+/i
    this.reHtmlLinks = /\s(href|src|action|srcset|poster)=("|')?(http\:|https\:|http\%3A|https\%3A|\/\/)[^\s\>]*/gi
    this.reCssUrls = /url\(["']?(http|\/\/)[^"')]+/gi
    this.reCssImports = /@import\s["'](http|\/\/)[^"']+/gi
    this.reDomainCheck = /[\w]+\./
    this.reHtmlEntity = /&#x\w+;/g
    this.reMetaCsp = /<meta\s+http-equiv="Content-Security-Policy"[^>]+>/i
    this.reScriptTags = /<script([^>]*)>([\S\s]*?)<\/script>/gi
    this.reHoistIds = /(function|class)\s+([\$\_\w]+)\s*\(/g
    this.reMetaCharset = /<meta charset=["'][^"'\/>]+/i
    this.reMetaContentType = /<meta http-equiv="Content-Type" content="text\/html;\s*charset=[^"'\/>]+/i
    this.reMetaCharsetReplace = /<meta charset=["'][^"'\/>]+["']>/i
    this.reCookieDomain = /domain=/i
    this.reWithThis = /[\s\{\}\;]?with\s*\(\s*this\s*\)/g
    this.reLocationProps = /\blocation\.(hostname|host|origin|href|protocol|navigate|assign|replace|reload|toString)\b/g
    this.reJsonp = /^[\w\$_]+\((\{|\[)/

    this.noTransformMimes = ['wasm', 'font', 'json', 'image', 'video', 'audio', 'pdf-office', 'stream', 'event-stream']
    this.cacheMimes = ['js', 'css', 'font', 'image', 'video', 'audio', 'pdf-office']
    this.cacheDir = config.cacheDir || 'cache'
    this.publicDir = config.publicDir || 'public'
    this.sslDir = config.sslDir || 'ssl'

    this.jsInterceptCode = fs.readFileSync(path.join(this.publicDir, 'intercept.js'))

    // rewriteThis 开启时预加载 acorn + magic-string，并缓存解析后的 AST 改写器
    this.rewriteThis = !!config.rewriteThis
    this._acorn = null
    this._MagicString = null
    if (this.rewriteThis) {
      getAcorn().then(acorn => { this._acorn = acorn }).catch(e => { console.error('[WebVPN] rewriteThis: failed to load acorn:', e) })
      getMagicString().then(MagicString => { this._MagicString = MagicString }).catch(e => { console.error('[WebVPN] rewriteThis: failed to load magic-string:', e) })
    }

    this.convertDomainsCode = `
      const httpVpnDomain = ${JSON.stringify(config.httpVpnDomain)}
      const httpsVpnDomain = ${JSON.stringify(config.httpsVpnDomain)}
      const subdomains = ${JSON.stringify(config.subdomains)}
      const domainDict = {}
      const domainMode = ${JSON.stringify(config.domainMode)}
      Object.entries(subdomains).forEach(([sub, name]) => domainDict[name] = sub)
      const _encode_host_original_ = text => {
        return domainDict[text] || text.replace(':', '_._')
      }
      const _decode_host_original_ = text => {
        return subdomains[text] || text.replace('_._', ':')
      }
      const _encode_host_underline_ = text => {
        let value = domainDict[text]
        if (!value) {
          value = text.replaceAll('.', '__').replaceAll('-', '_h_').replace(':', '_c_')
        }
        return value
      }
      const _decode_host_underline_ = text => {
        let value = subdomains[text]
        if (!value) {
          value = text.replace('_c_', ':').replaceAll('_h_', '-').replaceAll('__', '.')
        }
        return value
      }
      globalThis.encodeHost = domainMode === 'underline' ? _encode_host_underline_ : _encode_host_original_
      globalThis.decodeHost = domainMode === 'underline' ? _decode_host_underline_ : _decode_host_original_
    `
    new Function(this.convertDomainsCode)()

    this.jsWorkerContextCode = `
      // worker 里面创造 __context__ 环境
      if (!self.window) {
        setTimeout = self.setTimeout.bind(self)
        setInterval = self.setInterval.bind(self)
        clearTimeout = self.clearTimeout.bind(self)
        clearInterval = self.clearInterval.bind(self)
        const _importScripts  = self.importScripts
        self.importScripts = function (...props) {
          props = props.map(transformUrl)
          return _importScripts.apply(self, props)
        }
        const target = new URL('#targetUrl#')
        const site = new URL('#siteUrl#')
        const workerHost = self.location.host
        function transformUrl (url) {
          url = (url ? url.toString() : '').trim()
          if (url.startsWith('data:') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:') || url.startsWith('blob:') || url.startsWith('#')) {
            return url
          }
          if (url.startsWith('//')) {
            url = target.protocol + url
          } else if (url.startsWith('/')) {
            url = new URL(url, target.href).href
          } else if (url.indexOf('//') < 0) {
            return url
          }
          let u
          try { u = new URL(url) } catch { return url }
          const vpnDomain = u.protocol === 'http:' ? httpVpnDomain : httpsVpnDomain
          if (u.host.includes(vpnDomain)) return url
          let subdomain = encodeHost(u.host)
          const hostPrefix = workerHost.replace(vpnDomain, '')
          if (!hostPrefix.includes('.') && hostPrefix.includes('-')) {
            subdomain += '-' + hostPrefix.split('-').slice(-2).join('-')
          }
          return url.replace(u.host, subdomain + vpnDomain)
        }

        self.webvpn = { target, site, transformUrl }
        const globalCons = ['self', 'globalThis']
        const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']

        self.__location__ = {}
        locationAttrs.forEach(attr => {
          self.location['__' + attr + '__'] = webvpn.target[attr]
          const getter = () => webvpn.target[attr] || location[attr]
          Object.defineProperty(self.__location__, attr, { get: getter })
          Object.defineProperty(self.__location__, '__' + attr + '__', { get: getter })
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
            return true
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
            const reqInit = {}
            for (let key in input) {
              const value = input[key]
              if (key === 'url' || typeof value === 'function') continue
              if (key === 'mode' && value === 'navigate') continue
              reqInit[key] = value
            }
            input = new Request(newUrl, reqInit)
          }
          return fetch.apply(self, [input, init])
        }
      }
    `
    this.jsScopePrefixCode = `
    (function () {
      atob = self.atob.bind(self)
      addEventListener = self.addEventListener.bind(self)
      if (self.postMessage) {
        postMessage = self.postMessage.bind(self)
      }
      with (self.__context_proxy__) {
    `
    this.jsScopeSuffixCode = `
    }).call(self.__context__.self)
    `

    this.public = []
    this._initialized = this.init()
    this._initialized.catch(() => {})
  }

  async init () {
    await this.checkCaches()
    await this.initPublic()
  }

  async checkCaches () {
    if (this.config.cache) {
      this.caches = { }
      const dirs = await fsUtils.listDir(this.cacheDir)
      for (const dir of dirs) {
        this.caches[dir] = await fsUtils.listDir(path.join(this.cacheDir, dir))
      }
    }
  }

  async initPublic () {
    const files = await fsUtils.listDir(this.publicDir)
    this.public = files.map(file => path.join(this.publicDir, file))
  }

  async start () {
    await this._initialized
    if (this.config.numProcesses > 1 && cluster.isMaster) {
      for (let i = 0; i < this.config.numProcesses; i++) {
        cluster.fork()
      }
      cluster.on('listening', (worker, address) => {
        worker.on('message', ({ action, key, value, workerId }) => {
          if (action === 'setCache') {
            const params = { action: 'syncCache', key, value }
            for (let key in cluster.workers) {
              if (key === workerId) continue
              cluster.workers[key].send(params)
            }
          }
        })
        console.log(chalk.green(`listening: worker ${worker.process.pid} - Address: ${address.address}:${address.port}`))
      })
      cluster.on('exit', (worker, code, signal) => {
        console.log(chalk.yellow(`工作进程 ${worker.process.pid} 关闭 ${signal || code}. 重启中...`) + '\n')
        cluster.fork()
      })
    } else {
      this.createApp()
      if (!cluster.isMaster) {
        process.on('message', ({ action, key, value }) => {
          if (action === 'syncCache') {
            globalCache.syncItem(key, value)
          }
        })
      }
    }
  }

  async serveWww (ctx) {
    if (ctx.url === '/') {
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      let text = await fsUtils.read(path.join(this.publicDir, 'index.html'))
      text = text.replace(
        `'inject_code'`,
        'const config = ' + JSON.stringify(this.config, null, 2) + '\n' + this.convertDomainsCode
      )
      ctx.body = text
    } else if (ctx.url.startsWith('/share-sessions')) {
      if (ctx.method === 'POST') {
        const body = await this.calcRequestBody(ctx)
        await globalCache.setItem(ctx.query.shareId + '-clientCache', body)
      }
      ctx.res.writeHead(200, {
        'access-control-allow-credentials': 'true',
        'access-control-allow-origin': ctx.headers['origin'] || '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*'
      })
      ctx.res.end()
    } else {
      await this.checkPublic(ctx)
    }
  }

  async checkPublic (ctx) {
    const parts = ctx.url.split('/public/')
    let filepath = parts[1] && path.join(this.publicDir, parts[1]) || ''
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

  createApp () {
    const { config } = this
    const app = new Koa()
    app.use(this.proxyRoute.bind(this))

    const server = http.createServer({}, app.callback())
    this.servers = [server]

    this.wsServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      this.wsServer.handleUpgrade(request, socket, head, client => {
        this.onWsConnection(client, request)
      })
    })

    server.listen(config.port)

    if (config.httpsEnabled) {
      const options = {
        key: fs.readFileSync(path.join(this.sslDir, 'server.key')),
        cert: fs.readFileSync(path.join(this.sslDir, 'server.pem'))
      }
      const httpsServer = https.createServer(options, app.callback())
      httpsServer.on('upgrade', (request, socket, head) => {
        this.wsServer.handleUpgrade(request, socket, head, client => {
          this.onWsConnection(client, request)
        })
      })
      httpsServer.listen(config.httpsPort)
      this.servers.push(httpsServer)
    }

    // 优雅关闭（防止 createApp 多次调用时重复注册信号处理器）
    if (!this._signalRegistered) {
      this._signalRegistered = true
      const shutdown = () => this.shutdown()
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    }
  }

  async onWsConnection (client, request) {
    let { host, origin } = request.headers
    if (host) host = this.convertHost(host)
    // origin 缺失时（非浏览器客户端）按 socket 是否加密判断，而非强制 https
    const protocol = origin
      ? (origin.startsWith('https') ? 'https' : 'http')
      : (request.socket.encrypted ? 'https' : 'http')
    const url = protocol + '://' + host + (request.url || '')

    const wsClient = new WebSocket(url)
    wsClient.on('error', () => {
      try { client.close() } catch {}
    })
    await new Promise(resolve => {
      wsClient.on('open', resolve)
      wsClient.on('error', resolve)
    })
    wsClient.on('message', message => {
      message = message.toString()
      client.send(message)
    })
    wsClient.on('close', () => {
      client.close()
    })
    wsClient.on('error', () => {
      try { client.close() } catch {}
    })

    client.on('message', message => {
      message = message.toString()
      wsClient.send(message)
    })
    client.on('close', () => {
      wsClient.close()
    })
    client.on('error', () => {
      try { wsClient.close() } catch {}
    })
  }

  shutdown () {
    if (this._shuttingDown) return
    this._shuttingDown = true
    console.log(chalk.yellow('正在关闭服务器...'))
    for (const server of (this.servers || [])) {
      server.close()
    }
    if (this.wsServer) {
      for (const client of this.wsServer.clients) {
        client.terminate()
      }
      this.wsServer.close()
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }

  async proxyRoute (ctx, next) {
    const { httpVpnDomain, httpsVpnDomain, site } = this.config
    await next()
    let scheme
    try { scheme = new URL(ctx.request.href).protocol.slice(0, -1) } catch { scheme = 'http' }
    ctx.scheme = scheme
    const vpnDomain = ctx.scheme === 'http' ? httpVpnDomain : httpsVpnDomain
    const host = ctx.headers.host || ''
    let subdomain = host.endsWith(vpnDomain)
      ? host.slice(0, -vpnDomain.length)
      : host
    if (subdomain === 'www') {
      return await this.serveWww(ctx)
    } else {
      if (subdomain.split('-')[0] === vpnDomain.slice(1)) {
        ctx.res.writeHead(302, {
          location: ctx.scheme + '://' + site.host
        })
        return
      }
    }
    ctx.subdomain = subdomain

    const isPublic = await this.checkPublic(ctx)
    if (isPublic) {
      return
    }

    await this.routeInit(ctx)

    if (this.config.cache && ctx.meta.cache !== false) {
      if (await this.getCache(ctx)) {
        return
      }
    }

    if (this.noTransformMimes.includes(ctx.meta.mime)) {
      return await this.respondPipe(ctx)
    }

    let res = null
    try {
      res = await this.request(ctx)
    } catch (err) {
      console.log(chalk.red('proxyRoute request error: ' + err.toString()))
      try { ctx.res.writeHead(502); ctx.res.end('Bad Gateway') } catch {}
      ctx.meta.done = true
      return
    }
    if (res === true) return

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
        if (!ctx.meta.isXHR) {
          res.data = await this.appendScript(ctx, res)
        }
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

  async routeInit (ctx) {
    const { isMainSession, shareId } = await this.checkShareSession(ctx)
    const domain = decodeHost(ctx.subdomain)
    const url = ctx.scheme + '://' + domain + ctx.url
    ctx.meta = {
      shareId,
      isMainSession,
      url,
      isXHR: ctx.request.headers['x-requested-with'] === 'XMLHttpRequest',
      mime: this.getResponseType(ctx, url),
      scheme: ctx.scheme,
      target:  new URL(url),
      host: ctx.headers['host'],
      origin: ctx.headers['origin'],
      referer: ctx.headers['referer']
    }
  }

  async checkShareSession (ctx) {
    let isMainSession = false, shareId = ''
    // 使用正则匹配会话后缀 -(main|share)-<shareId>，兼容 original 和 underline 两种模式。
    // original 模式下 subdomain 含点号（如 www.example.com-main-shareId），
    // 此前用 !includes('.') 判断会跳过 original 模式的会话共享。
    // shareId 不含点号，故用 [^.]+ 匹配。
    const sessionMatch = ctx.subdomain.match(/-(main|share)-([^.]+)$/)
    if (sessionMatch) {
      ctx.subdomain = ctx.subdomain.slice(0, sessionMatch.index)
      isMainSession = sessionMatch[1] === 'main'
      shareId = sessionMatch[2]
      const shareSuffix = '-' + sessionMatch[1] + '-' + shareId
      for (let key of ['host', 'origin', 'referer']) {
        if (ctx.headers[key]) {
          ctx.headers[key] = ctx.headers[key].replace(shareSuffix, '')
        }
      }
      if (isMainSession) {
        if (ctx.headers['cookie']) {
          await globalCache.setItem(shareId + '-cookie', ctx.headers['cookie'])
        }
        if (ctx.headers['authorization']) {
          await globalCache.setItem(shareId + '-authorization', ctx.headers['authorization'])
        }
      } else {
        const cookie = await globalCache.getItem(shareId + '-cookie')
        const authorization = await globalCache.getItem(shareId + '-authorization')
        if (cookie) ctx.headers['cookie'] = cookie
        if (authorization) ctx.headers['authorization'] = authorization
      }
    }
    // 此前此处还有第二段循环：用 new URL(origin).host.split('.')[0] 再次解析会话后缀并删除。
    // 但上面第一段已用 shareSuffix 精确清理 origin/referer，第二段在 original 模式下
    // （编码 host 是多段子域名）会把目标域名第一段当 subdomain，split('-') 后误删，
    // 反而破坏已被清理干净的 header。整段删除。
    return { isMainSession, shareId }
  }

  getContentTypeByExt (filepath) {
    const ext = path.extname(filepath).slice(1).toLowerCase()
    const dict = {
      html: 'text/html; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
      mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', eot: 'application/vnd.ms-fontobject',
      pdf: 'application/pdf', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8'
    }
    return dict[ext] || 'application/octet-stream'
  }

  async respondFile (ctx, filepath) {
    ctx.res.writeHead(200, { 'Content-Type': this.getContentTypeByExt(filepath) })
    const stream = fs.createReadStream(filepath)
    // 此前仅监听 error；客户端中途断开会触发 close 而非 error，
    // stream 继续读取并写入已关闭的 socket 导致泄漏与 write-after-end 警告。
    await new Promise(resolve => {
      let resolved = false
      const finish = () => { if (resolved) return; resolved = true; resolve() }
      const cleanup = () => { stream.destroy(); finish() }
      stream.pipe(ctx.res)
      stream.on('end', finish)
      stream.on('error', () => {
        try { ctx.res.writeHead(500); ctx.res.end('Internal Server Error') } catch {}
        finish()
      })
      ctx.res.on('error', cleanup)
      ctx.res.on('close', cleanup)
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
    const result = await this.beforeRequest(ctx, options)
    if (result) return result
    await new Promise(resolve => {
      let resolved = false
      const finish = () => { if (resolved) return; resolved = true; resolve() }
      const lib = isHttps ? https : http
      const req = lib.request(options, async res => {
        const headers = await this.initResponseHeaders(ctx, res)
        this.deleteIgnoreHeaders(this.ignoreResponseHeaderRegexps, headers)
        ctx.res.writeHead(res.statusCode, headers)
        res.pipe(ctx.res)
        // 客户端中途断开时 ctx.res 触发 close（非 error），需销毁上游 res 流避免泄漏
        const cleanup = () => { res.destroy(); req.destroy(); finish() }
        res.on('end', finish)
        res.on('error', () => {
          try { ctx.res.writeHead(500); ctx.res.end('Internal Server Error') } catch {}
          finish()
        })
        ctx.res.on('error', cleanup)
        ctx.res.on('close', cleanup)
      })
      req.on('error', err => {
        const msg = 'pipe request failed: ' + ctx.meta.url + ' - ' + err.toString()
        console.log(chalk.red(msg))
        try { ctx.res.writeHead(502); ctx.res.end('Bad Gateway') } catch {}
        finish()
      })
      req.setTimeout(this.config.requestTimeout || 60000, () => {
        req.destroy()
        try { ctx.res.writeHead(504); ctx.res.end('Gateway Timeout') } catch {}
        finish()
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
    if (result) return result
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout || 60000)
      options.signal = controller.signal
      try {
        return await this.fetchRequest(ctx, options)
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      const msg = 'request failed: ' + ctx.meta.url + '\n' + err.toString()
      console.log(chalk.red(msg) + '\n')
      if (err.name === 'AbortError') {
        try { ctx.res.writeHead(504); ctx.res.end('Gateway Timeout') } catch {}
      } else {
        try { ctx.res.writeHead(502); ctx.res.end('Bad Gateway') } catch {}
      }
      ctx.meta.done = true
      return { status: 502, data: '', headers: {} }
    }
  }

  async calcRequestBody (ctx) {
    const hasFile = ctx.headers['content-type']?.includes('multipart/form-data; boundary')
    if (hasFile) {
      // multipart/form-data 保留原始字节流，直接交给 node-fetch 透传
      // 之前用 FormData 重建会丢失字段名、文件名、boundary，导致上传数据损坏
      const chunks = []
      await new Promise(resolve => {
        ctx.req.on('data', chunk => chunks.push(chunk))
        ctx.req.on('end', resolve)
        ctx.req.on('error', resolve)
      })
      return Buffer.concat(chunks)
    }
    let body = ''
    await new Promise(resolve => {
      ctx.req.on('data', chunk => { body += chunk })
      ctx.req.on('end', resolve)
      ctx.req.on('error', resolve)
    })
    return body
  }

  async fetchRequest (ctx, options) {
    const res = await fetch(ctx.meta.url, options)
    const headers = await this.initResponseHeaders(ctx, res)

    if (headers.location) {
      ctx.res.writeHead(res.status, headers)
      ctx.meta.done = true
      return { status: res.status, headers }
    }

    let data = ''
    ctx.meta.mime = this.getMimeByResponseHeaders(headers) || ctx.meta.mime

    if (this.noTransformMimes.includes(ctx.meta.mime)) {
      // node-fetch 会自动解压 gzip/deflate/br，必须删除对应的 content-encoding 头，
      // 否则浏览器会对已解压的 body 再次解压。zstd node-fetch 不会自动解压，保留让浏览器处理。
      const encoding = (headers['content-encoding'] || '').toString().toLowerCase()
      if (encoding.includes('gzip') || encoding.includes('deflate') || encoding.includes('br')) {
        delete headers['content-encoding']
      }
      ctx.meta.done = true
      if (ctx.meta.mime === 'json') {
        // content-encoding 已在上面的 if 中删除，此处不再重复
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
        let resolved = false
        const finish = () => { if (resolved) return; resolved = true; resolve() }
        const cleanup = () => { res.body.destroy(); finish() }
        res.body.on('end', finish)
        res.body.on('error', () => {
          try { ctx.res.statusCode = 500; ctx.res.end() } catch {}
          finish()
        })
        ctx.res.on('error', cleanup)
        ctx.res.on('close', cleanup)
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
    const match = res.data.match(this.reBase)
    if (match) {
      const text = match[0]
      const index = Math.max(text.indexOf('"'), text.indexOf('\''))
      return text.slice(index + 1)
    }
    return ctx.meta.target.pathname.split('/').slice(0, -1).join('/') + '/'
  }

  getHtmlLinkMatches (ctx, res) {
    return [...new Set(res.data.match(this.reHtmlLinks))]
  }

  getCssUrlMatches (ctx, res) {
    return [
      ...new Set(res.data.match(this.reCssUrls)),
      ...new Set(res.data.match(this.reCssImports))
    ]
  }

  replaceMatches (ctx, res, matches) {
    const { httpVpnDomain, httpsVpnDomain } = this.config
    const dict = {}
    matches.filter(m => {
      return !m.includes('\n') && m.indexOf(httpVpnDomain) < 0 && m.indexOf(httpsVpnDomain) < 0
    }).forEach(match => {
      let url = ''
      let prefix = ''
      let quote = ''
      if (match.slice(0, match.indexOf('//')).indexOf('http') >= 0) {
        // 正则 [^"')]+ / [^\s>]* 已不含尾部分隔符，slice(..., -1) 会截掉 URL 末尾字符：
        // 有路径时仅影响路径（host 提取不受影响），但无路径 URL（如 url(http://example.com)）
        // 会导致 host 被截断（example.com → example.co），替换 key 不匹配，URL 漏改。
        url = match.slice(match.indexOf('http'))
        // 此前用 match.indexOf('https') > 0 判断协议，路径含 'https' 时误判；改为检查 url 前缀
        prefix = url.startsWith('https') ? 'https://' : 'http://'
      } else {
        url = ctx.meta.scheme + ':' + match.slice(match.indexOf('//'))
        quote = match[match.indexOf('//') - 1]
        prefix = '//'
      }
      const u = url.slice(url.indexOf('//') + 2)
      if (!u || !this.reDomainCheck.test(u)) return
      url = url.replaceAll(this.reHtmlEntity, ele => String.fromCharCode(parseInt(ele.slice(3, -1), 16)))
      if (url.includes('"')) {
        url = url.replaceAll('"', '')
      }
      let host
      try { host = new URL(url).host } catch { return }
      const source = prefix + host
      const value = this.transformUrl(ctx, source.startsWith('http') ? source : (ctx.meta.scheme + ':' + source))
      dict[quote + source] = quote + value
    })
    // 此前对每个 key 单独调用 res.data.replaceAll(key, value) 是 O(n×m)：
    // n 个模式各扫描一遍 m 长度的文本。改为构造单一正则一次遍历替换。
    const keys = Object.keys(dict)
    if (keys.length === 0) return res.data
    // 按长度降序，避免短 key 先命中长 key 的前缀
    keys.sort((a, b) => b.length - a.length)
    const pattern = new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    res.data = res.data.replace(pattern, m => dict[m] !== undefined ? dict[m] : m)
    return res.data
  }

  transformUrl (ctx, url) {
    const { httpVpnDomain, httpsVpnDomain } = this.config
    let u
    try { u = new URL(url) } catch { return url }
    const vpnDomain = u.protocol === 'http:' ? httpVpnDomain : httpsVpnDomain
    return url.replace(u.host, encodeHost(u.host) + vpnDomain)
  }

  processHtml (ctx, res) {
    const match = res.data.match(this.reMetaCsp)
    if (match) {
      res.data = res.data.replace(match[0], '')
    }
    return res.data
  }

  processHtmlScopeCodes (ctx, code) {
    const matches = [...code.matchAll(this.reScriptTags)].filter(match => {
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
    let result = ''
    if (isJsFile) {
      result += this.jsWorkerContextCode.replace('if (!self.window) {', 'if (!self.window) {\n' + this.convertDomainsCode)
        .replace('#targetUrl#', target.href).replace('#siteUrl#', siteUrl)
    }
    result += this.jsScopePrefixCode
            + code
            + '\n}\n'
            + this.calcHoistIdentifiersCode(code)
            + this.jsScopeSuffixCode
    return result
  }

  calcHoistIdentifiersCode (code) {
    const matches = [...code.matchAll(this.reHoistIds)]
    if (!matches.length) return ''
    const names = matches.map(m => m[2]).filter(k => !this.jsKeywords.includes(k))
    return names.map(n => `try { self.${n} = ${n}; } catch {}`).join('\n')
  }

  async appendScript (ctx, res) {
    const {
      httpsEnabled, httpVpnDomain, httpsVpnDomain,
      interceptLog, enablePlugins, debug, disableDevtools
    } = this.config
    const { disableJump = this.config.disableJump, confirmJump = this.config.confirmJump } = ctx.meta
    const { base, scheme, target, isMainSession, shareId, customCode } = ctx.meta
    const { data } = res
    const prefix = '//www' + (httpsEnabled && scheme === 'https' ? httpsVpnDomain : httpVpnDomain)
    const siteUrl = (httpsEnabled ? scheme : 'http') + ':' + prefix
    const pageUrl = this.transformUrl(ctx, target.href)
    const code = `
    <script>
      self.webvpn = {
        siteUrl: ${JSON.stringify(siteUrl)},
        protocol: ${JSON.stringify(scheme + ':')},
        sourceUrl: ${JSON.stringify(target.href)},
        pageUrl: ${JSON.stringify(pageUrl)},
        hostname: ${JSON.stringify(target.hostname)},
        httpVpnDomain: ${JSON.stringify(httpVpnDomain)},
        httpsVpnDomain: ${JSON.stringify(httpsVpnDomain)},
        base: ${JSON.stringify(base)},
        interceptLog: ${interceptLog},
        disableJump: ${disableJump},
        confirmJump: ${confirmJump},
        isMainSession: ${isMainSession},
        shareId: ${JSON.stringify(shareId)},
      };
      const convertDomainsCode = ${JSON.stringify(this.convertDomainsCode)}
      ;new Function(convertDomainsCode)()
      ${customCode || ''}
      webvpn.intercept_code = ${JSON.stringify(this.jsInterceptCode.toString())}
      eval(webvpn.intercept_code)
      webvpn.worker_wrapper_code = convertDomainsCode + ${JSON.stringify('\n' + this.jsWorkerContextCode.replace('#siteUrl#', siteUrl) + '\n' + this.jsScopePrefixCode + '\n  #CODE#\n}\n' + this.jsScopeSuffixCode + '\n')}
    </script>
    ${
      enablePlugins
      ?
      `<script src="${prefix}/public/plugins.js"></script>`
      : ''
    }
    ${
      debug && !disableDevtools
      ? `
        <script src="https://cdnjs.cloudflare.com/ajax/libs/vConsole/3.15.1/vconsole.min.js"></script>
        <script>new VConsole()</script>
      `
      : ''
    }
    ${
      disableDevtools
      ?
      `<script src="${prefix}/public/disable-devtools.js"></script>`
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
        try {
          const clientCache = ${JSON.stringify(await globalCache.getItem(shareId + '-clientCache') || '{}')}
          const { cookie, localStorage: local } = JSON.parse(clientCache)
          if (cookie) document.cookie += cookie
          if (local) {
            localStorage.clear()
            for (let key in local) localStorage[key] = local[key]
          }
        } catch (e) { console.warn('webvpn session restore failed:', e) }
      </script>`
      : ''
    }
    <script>
      const ss = Array.from(document.querySelectorAll('script'));
      ss.forEach(script => script.remove());
    </script>
    `
    const hasDoctype = /^\s*?\<\!DOCTYPE html\>/i.test(res.data)
    return (hasDoctype ? '<!DOCTYPE html>\n' : '') + code + data
  }

  processOthers (ctx, res) {
    // 此前有 res.data = JSON.stringify(res.data) 的死分支：
    // res.data 本就是字符串（来自 res.text()），再次 stringify 会双重编码 JSON 文本，导致客户端拿到被破坏的 JSON。已移除。
    if (this.config.disableSourceMap) {
      if (ctx.meta.mime === 'html' || ctx.meta.mime === 'js') {
        res.data = res.data.replaceAll('sourceMappingURL', '')
      }
    }
  }

  getResponseType (ctx, url) {
    if (ctx.method === 'PUT' || ctx.method === 'POST') return 'text'
    const index = url.indexOf('?')
    const link = index < 0 ? url : url.slice(0, index)
    for (let reg of this.mimeRegs) {
      if (reg[0].test(link)) {
        return reg[1]
      }
    }
    let pathname = ''
    try { pathname = new URL(link).pathname } catch {}
    if (pathname === '/') {
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

  async initResponseHeaders (ctx, res) {
    const { httpsEnabled, vpnDomain, httpVpnDomain, httpsVpnDomain, domainMode, site } = this.config
    const { isMainSession, shareId, scheme, target } = ctx.meta
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
        // 目标站可能返回 null / 畸形 origin，new URL 会抛异常导致整个响应处理中断
        let host
        try {
          host = e.indexOf('http') >= 0 ? new URL(e).host : e
        } catch {
          return e
        }
        const vpnDomain = e.indexOf('http://') >= 0 ? httpVpnDomain : httpsVpnDomain
        let domain = encodeHost(host)
        if (shareId) {
          domain += '-' + (isMainSession ? 'main' : 'share') + '-' + shareId
        }
        domain += vpnDomain
        return e.replace(host, domain)
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
        const protocol = (httpsEnabled ? scheme : 'http') + '://'
        return e.replace(
          'frame-ancestors',
          'frame-ancestors ' + protocol + site.host.replace(/^www\./, '*.')
        )
      })
    }
    if (headers['location']) {
      headers['location'] = headers['location'].map(e => {
        if (!e.startsWith('http')) {
          if (e[0] === '/') {
            e = target.origin + e
          }
        }
        return this.transformUrl(ctx, e)
      })
    }
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(e => {
        // 此前用字符串 ' Secure;' 替换，仅能命中中间位置（带分号后缀）的 Secure；
        // 末尾的 Secure（如 "name=value; Path=/; Secure"）不会被移除，
        // 导致 HTTP 部署下浏览器因 Secure 标志丢弃该 cookie。
        // 改用正则匹配所有位置的 Secure 标志（含大小写、无空格、末尾等情形）。
        e = e.replace(/;\s*Secure\b/gi, '')
        if (!this.reCookieDomain.test(e)) {
          // let domain = encodeHost(target.host)
          // if (shareId) domain += '-' + (isMainSession ? 'main' : 'share') + '-' + shareId
          // domain += vpnDomain
          // return e + '; domain=' + domain
          return e
        }
        return e.split('; ').map(p => {
          if (!this.reCookieDomain.test(p)) return p
          let domain = p.split('=')[1]
          const hasDot = domain[0] === '.'
          if (hasDot) domain = domain.slice(1)
          if (domainMode === 'original') {
            domain = encodeHost(domain)
            if (shareId) domain += '-' + (isMainSession ? 'main' : 'share') + '-' + shareId
            domain += vpnDomain
            if (hasDot) domain = '.' + domain
          } else {
            // warn warn warn warn warn warn
            // underline 模式不支持 cookie domain
            domain = vpnDomain
          }
          return 'domain=' + domain
        }).join('; ')
      })
    }
    if (!headers['access-control-allow-origin']) {
      headers['access-control-allow-origin'] = ['*']
    }
    if (this.config.httpsEnabled && scheme === 'https') {
      if (!headers['content-security-policy']) {
        headers['content-security-policy'] = []
      }
      headers['content-security-policy'].push('upgrade-insecure-requests')
    }
    headers['x-frame-options'] = ['allowall']
    if (!isMainSession && shareId) {
      const cookie = await globalCache.getItem(shareId + '-cookie')
      if (cookie) {
        // 缓存的 cookie 是 Cookie 请求头格式（"a=1; b=2"），需拆分为单个 cookie
        // 再与目标响应自身的 set-cookie 合并，避免覆盖目标站点新设置的 cookie
        const cached = cookie.split(';').map(c => c.trim()).filter(Boolean)
        const existing = Array.isArray(headers['set-cookie'])
          ? headers['set-cookie']
          : (headers['set-cookie'] ? [headers['set-cookie']] : [])
        headers['set-cookie'] = [...cached, ...existing]
      }
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
      // origin/referer 来自客户端、不可信，new URL 须 try/catch；改用 URL 重组 host
      // 避免字符串 .replace(host, ...) 在路径中误伤同名子串
      try {
        const u = new URL(headers['origin'])
        u.host = this.convertHost(u.host)
        headers['origin'] = u.origin
      } catch {}
    }
    const referer = headers['referer']
    if (referer) {
      const { site, httpVpnDomain, httpsVpnDomain } = this.config
      const vpnDomain = referer.startsWith('http://') ? httpVpnDomain : httpsVpnDomain
      if (referer.indexOf(site.host) < 0 || referer.indexOf(vpnDomain) < 0) {
        delete headers['referer']
      } else {
        try {
          const u = new URL(referer)
          u.host = this.convertHost(u.host)
          headers['referer'] = u.toString()
        } catch {
          delete headers['referer']
        }
      }
    }
  }

  convertHost (host) {
    if (!host) return host
    const { httpVpnDomain, httpsVpnDomain, vpnDomain } = this.config
    // 非 vpn 域名的 host 直接返回，避免对第三方域名误跑 decodeHost 破坏其原样
    if (!host.includes(vpnDomain) && !host.includes(httpVpnDomain) && !host.includes(httpsVpnDomain)) {
      return host
    }
    // 先剥离 vpnDomain（含端口后缀）和会话共享后缀 -(main|share)-<id>，
    // 再把剩余整体交给 decodeHost。此前用 split('-')[0] 截断，在 original 模式下
    // 目标域名本身的连字符（如 a-b.example.com，original 模式不编码 -）会被误切。
    host = host.replace(httpsVpnDomain, '').replace(httpVpnDomain, '')
    host = host.replace(/-(main|share)-[^.]+$/, '')
    return decodeHost(host)
  }

  async convertCharsetData (ctx, headers, res) {
    if (ctx.meta.mime !== 'html' && ctx.meta.mime !== 'js') {
      return res.text()
    }
    let text, buffer
    if (res.headers.get('content-encoding') === 'zstd') {
      res.headers.delete('content-encoding')
      // 先收集原始字节 Buffer，再统一 decode；此前用 body += chunk 会隐式 toString('utf8')，
      // 非 utf-8 页面的字节被提前腐蚀，后续 iconv.decode 无法正确还原。
      const chunks = []
      await new Promise(resolve => {
        const stream = res.body.pipe(ZSTDDecompress())
        stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', resolve)
        stream.on('error', resolve)
      })
      buffer = Buffer.concat(chunks)
      text = iconv.decode(buffer, 'utf-8')
    } else {
      buffer = Buffer.from(await res.arrayBuffer())
      text = iconv.decode(buffer, 'utf-8')
    }
    let contentType = headers['content-type']?.[0] || ''
    let charset = contentType.split('charset=')[1]?.toLowerCase()
    if (!charset) {
      let match = text.match(this.reMetaCharset)
      if (!match) {
        match = text.match(this.reMetaContentType)
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
      text = text.replace(this.reMetaCharsetReplace, '<meta charset="utf-8">')
    }
    return text
  }

  isJsonpResponse (data, ctx) {
    if (ctx.meta.mime === 'html') {
      return this.reJsonp.test(data)
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
                // 仅改写 location.<prop> 形式的属性访问，避免命中字符串/注释中的文本
                // 通过词法边界 (\\b) 与点号约束，降低误匹配
                .replace(this.reLocationProps, 'location.__$1__')
      if (this.rewriteThis) {
        // 开启 rewriteThis：用 acorn AST 解析所有 this，替换为 (this === self ? __self__ : this)
        // 覆盖默认的 with(this) 正则改写（更彻底，拦截任何 this 穿透获得 window 的可能）
        this.rewriteThisInResponse(ctx, res)
      } else {
        // 默认：仅用正则改写 with(this) 模式（性能更好）
        res.data = res.data.replace(this.reWithThis, ' with(this === self ? __self__ : this)')
      }
    }
  }

  /// rewriteThis 开启时，对响应中的 JS 代码做 acorn AST 解析，把每个 this 替换为
  /// (this === self ? __self__ : this)。HTML 响应只解析内联 <script> 内容，避免把
  /// HTML 标签当 JS 解析导致报错。解析失败时回退到正则 with(this) 改写。
  rewriteThisInResponse (ctx, res) {
    const acorn = this._acorn
    const MagicString = this._MagicString
    // 模块尚未加载完成（启动瞬间）：回退到正则，保证不漏改
    if (!acorn || !MagicString) {
      res.data = res.data.replace(this.reWithThis, ' with(this === self ? __self__ : this)')
      return
    }
    if (ctx.meta.mime === 'js') {
      res.data = this.rewriteThisInJs(res.data, acorn, MagicString)
    } else if (ctx.meta.mime === 'html') {
      // 快速跳过：整个 HTML 都不含 this 时无需做脚本抽取与解析
      if (!res.data.includes('this')) return
      // 抽取内联 <script> 内容逐段改写（倒序回填避免位置偏移）
      const matches = [...res.data.matchAll(this.reScriptTags)].filter(match => {
        const typeIndex = match[1].indexOf('type=')
        let isScript = true
        if (typeIndex > 0) {
          const type = match[1].slice(typeIndex + 6).split(match[1][typeIndex + 5])[0]
          isScript = type.indexOf('javascript') >= 0
          if (!isScript && type.indexOf('text/') < 0 && !type.includes('json')) {
            isScript = true
          }
        }
        return isScript && match[2]
      })
      matches.sort((a, b) => b.index - a.index)
      let data = res.data
      for (const match of matches) {
        const index = match[0].length - match[2].length - 9 + match.index
        const rewritten = this.rewriteThisInJs(match[2], acorn, MagicString)
        data = data.slice(0, index) + rewritten + data.slice(index + match[2].length)
      }
      res.data = data
    } else {
      // 其他类型：回退到正则 with(this) 改写
      res.data = res.data.replace(this.reWithThis, ' with(this === self ? __self__ : this)')
    }
  }

  /// 用 acorn 解析单段 JS 代码，把每个 ThisExpression 的 this 替换为
  /// (this === self ? __self__ : this)。解析失败时回退到正则。
  rewriteThisInJs (code, acorn, MagicString) {
    // 快速跳过：代码不含 this 关键字时无需启动 acorn（this 总是以字面量 "this" 出现）
    if (!code.includes('this')) return code
    let ast
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowReturnOutsideFunction: true
      })
    } catch {
      // 非标准/损坏的 JS：回退到正则 with(this) 改写，至少覆盖最常见的场景
      return code.replace(this.reWithThis, ' with(this === self ? __self__ : this)')
    }
    const ms = new MagicString(code)
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'ThisExpression') {
        ms.overwrite(node.start, node.end, '(this === self ? __self__ : this)')
      }
      for (const key of Object.keys(node)) {
        const val = node[key]
        if (Array.isArray(val)) {
          for (const child of val) walk(child)
        } else if (val && typeof val === 'object' && val.type) {
          walk(val)
        }
      }
    }
    walk(ast)
    return ms.toString()
  }

  beforeResponse (ctx, res) { }
}

export default WebVPN
