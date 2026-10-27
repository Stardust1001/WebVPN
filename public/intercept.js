(function () {
  if (window.webvpn.transformUrl) return

  const logTypes = ['AJAX', 'fetch', 'History']
  const ignoredPrefixes = ['mailto:', 'sms:', 'tel:', 'javascript:', 'data:', 'blob:']
  const globalCons = ['window', 'document', 'globalThis', 'parent', 'self', 'top']
  const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']
  /* 本脚本包装过、经 document 原型链可达的方法：快照恢复（heal）必须跳过它们，
     否则每次属性读取都会把包装还原成原生方法，拦截失效。 */
  const ownWrappedMethods = [
    'write', 'writeln', 'addEventListener', 'removeEventListener',
    'appendChild', 'insertBefore', 'replaceChild', 'createTreeWalker'
  ]

  const siteU = new URL(webvpn.siteUrl)
  const sourceU = new URL(webvpn.sourceUrl)
  const pageU = new URL(webvpn.pageUrl)
  const base = webvpn.base
  const { httpVpnDomain, httpsVpnDomain } = webvpn

  /* <html> 之前的 <script> 代码，获取不到 location.href 等网址信息，通过 webvpn.sourceUrl 来提供 */
  const location = new Proxy(window.location, {
    get (obj, property, receiver) {
      if (property.includes('__')) {
        const prop = property.replaceAll('__', '')
        if (locationAttrs.includes(prop)) {
          return sourceU[prop]
        }
      } else {
        if (locationAttrs.includes(property) && !obj[property]) {
          return pageU[property]
        }
      }
      return obj[property]
    }
  })

  const defineWebvpnLocation = () => {
    Object.defineProperties(webvpn, {
      location: {
        get () {
          return location
        }
      },
      currentHref: {
        get () {
          let url = decodeUrl(location.href)
          if (!url.startsWith(webvpn.protocol)) {
            url = url.replace(webvpn.protocol === 'https:' ? 'http:' : 'https:', webvpn.protocol)
          }
          return url
        }
      },
      target: {
        get () {
          return new URL(webvpn.currentHref)
        }
      }
    })
  }
  defineWebvpnLocation()

  const ajaxUrls = []
  const fetchUrls = []
  const domUrls = []
  const blobs = {}

  const interceptLog = webvpn.interceptLog
  const disableJump = webvpn.disableJump
  const confirmJump = webvpn.confirmJump

  /* AST 模式（rewriteThis=true）：同步加载 WASM AST 改写模块。
     旧模式（rewriteThis=false）不加载，行为完全不变。
     方案 C：同步 XHR + 同步 WebAssembly 实例化，避免异步竞态。 */
  let __wasmRewrite = null
  if (webvpn.rewriteThis) {
    try {
      const xhr = new XMLHttpRequest()
      // 同源加载：从当前代理子域请求 /public/rewrite.wasm（checkPublic 在所有子域生效）。
      // 若用 siteU.origin（www 主域）会跨子域，浏览器因无 CORS 头阻止 XHR。
      xhr.open('GET', '/public/rewrite.wasm', false)
      // 同步 XHR 禁止设置 responseType（会抛 InvalidAccessError），改用
      // x-user-defined 字符集按字节透传：byte < 0x80 → 同码位，
      // byte >= 0x80 → U+F780+(byte-0x80)，charCodeAt(i) & 0xff 可无损还原字节。
      xhr.overrideMimeType('text/plain; charset=x-user-defined')
      xhr.send()
      if (xhr.status === 200 && xhr.responseText) {
        const raw = xhr.responseText
        const wasmBytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) wasmBytes[i] = raw.charCodeAt(i) & 0xff
        const wasmModule = new WebAssembly.Module(wasmBytes)
        const wasmInstance = new WebAssembly.Instance(wasmModule)
        const wasmExports = wasmInstance.exports
        const wasmMemory = wasmExports.memory
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        __wasmRewrite = {
          rewrite (code) {
            if (!code || typeof code !== 'string') return code
            const bytes = encoder.encode(code)
            const ptr = wasmExports.alloc_input(bytes.length)
            if (!ptr) return code
            new Uint8Array(wasmMemory.buffer, ptr, bytes.length).set(bytes)
            const result = wasmExports.rewrite_js(ptr, bytes.length)
            // rewrite_js 返回 u64，JS 侧收到 BigInt（WASM i64 映射）。
            // 0n 表示解析失败。
            if (result === 0n) return null
            const resultPtr = Number(result & 0xFFFFFFFFn)
            const resultLen = Number(result >> 32n)
            if (resultLen === 0) return ''
            const output = decoder.decode(new Uint8Array(wasmMemory.buffer, resultPtr, resultLen))
            wasmExports.free_wasm(resultPtr, resultLen)
            return output
          }
        }
      }
    } catch (e) {
      console.warn('[WebVPN] WASM rewrite module failed to load:', e)
    }
  }

  const linkTags = ['a', 'img', 'script', 'link', 'video', 'audio', 'source', 'iframe', 'form', 'embed', 'object']
  const urlAttrs = ['href', 'src', 'srcset', 'poster', 'action', 'data', 'codebase']
  const nodeAttrSetters = [
    [HTMLAnchorElement, 'a', 'href'],
    [HTMLImageElement, 'img', 'src'],
    [HTMLImageElement, 'img', 'srcset'],
    [HTMLScriptElement, 'script', 'src'],
    [HTMLLinkElement, 'link', 'href'],
    [HTMLVideoElement, 'video', 'src'],
    [HTMLVideoElement, 'video', 'poster'],
    [HTMLAudioElement, 'audio', 'src'],
    [HTMLSourceElement, 'source', 'src'],
    [HTMLSourceElement, 'source', 'srcset'],
    [HTMLIFrameElement, 'iframe', 'src'],
    [HTMLFormElement, 'form', 'action'],
    [HTMLEmbedElement, 'embed', 'src'],
    [HTMLObjectElement, 'object', 'data'],
    [HTMLObjectElement, 'object', 'archive'],
    [HTMLObjectElement, 'object', 'codeBase'],
  ]
  const nodeNameAttrsMap = {}
  nodeAttrSetters.forEach((item) => {
    nodeNameAttrsMap[item[1]] = nodeNameAttrsMap[item[1]] || []
    nodeNameAttrsMap[item[1]].push(item[2])
  })

  const transformUrl = (url) => {
    url = (url ? url.toString() : '').trim()
    for (let prefix of ignoredPrefixes) {
      if (url.startsWith(prefix)) {
        return url
      }
    }
    if (!url || url.split('?')[0].indexOf('//') < 0) {
      return url
    }
    if (url.indexOf('http') < 0 && url.indexOf('//') > 0) {
      url = url.slice(url.indexOf('//'))
    }
    if (url.startsWith('//')) {
      url = webvpn.protocol + url
    }
    if (url.indexOf('http://') > 0 || url.indexOf('https://') > 0) {
      url = url.slice(url.indexOf('http'))
    }
    let u
    try { u = new URL(url) } catch { return url }
    const vpnDomain = u.protocol === 'https:' ? httpsVpnDomain : httpVpnDomain
    if (u.host.includes(vpnDomain)) {
      // if (url.startsWith('http') && webvpn.protocol === 'http:') {
        // return url.replace('https://', 'http://')
      // }
      return url
    }
    let subdomain = encodeHost(u.host)
    const hostPrefix = location.host.replace(vpnDomain, '')
    if (!hostPrefix.includes('.') && hostPrefix.includes('-')) {
      subdomain += '-' + hostPrefix.split('-').slice(-2).join('-')
    }
    return url.replace(u.host, subdomain + vpnDomain)
  }

  const decodeUrl = (url) => {
    url = (url || '').trim()
    if (!url) return url
    for (const prefix of ignoredPrefixes) {
      if (url.startsWith(prefix)) return url
    }
    if (url.split('?')[0].indexOf('http') < 0) {
      return urljoin(location.href, url)
    }
    if (url.indexOf('http://') > 0 || url.indexOf('https://') > 0) {
      url = url.slice(url.indexOf('http'))
    }
    let u
    try { u = new URL(url) } catch { return url }
    const vpnDomain = u.protocol === 'https:' ? httpsVpnDomain : httpVpnDomain
    if (!u.host.includes(vpnDomain)) return url
    let subdomain = u.host.replace(vpnDomain, '')
    if (!subdomain.includes('.') && subdomain.includes('-')) {
      subdomain = subdomain.split('-')[0]
    }
    const host = decodeHost(subdomain)
    url = url.replace(u.host, host)
    if (webvpn.hostname.includes(host) && webvpn.protocol === 'https:' && url.startsWith('http:')) {
      url = url.replace('http:', 'https:')
    }
    return url
  }

  const transformArgumentsNodes = (nodes, funcName) => {
    for (let i = 0, len = nodes.length; i < len; i++) {
      const node = nodes[i]
      domLog(node, funcName)
      nodes[i] = transformNode(node)
    }
  }

  const transformNode = (node) => {
    const tag = getNodeName(node)
    if (linkTags.includes(tag)) {
      const link = getNodeUrl(node)
      const url = link[0]
      const urlAttr = link[1]
      const newUrl = transformUrl(url)
      node[urlAttr] = newUrl
    }
    replaceNodesUrls(node)
    if (node.nodeName === 'SCRIPT') {
      node.removeAttribute('integrity')
    } else if (node.nodeName === 'STYLE') {
      transformStyleNode(node)
    }
    if (node.nodeName === 'SCRIPT' && !node.src && !node.textContent.includes('self.__context__')) {
      if (node.textContent[0] === '{' || node.textContent[0] === '[') {
        try {
          JSON.parse(node.textContent)
        } catch {
          if (webvpn.rewriteThis && __wasmRewrite) {
            // AST 模式：WASM 改写后直接作为脚本内容（服务端已做过一次 AST 改写，这里是 DOM 动态插入的兜底）
            const rewritten = __wasmRewrite.rewrite(node.textContent)
            if (rewritten !== null) node.textContent = rewritten
          } else {
            // 旧模式：with 包裹，在 __context__ 作用域运行
            // 改用 JSON.stringify 安全编码：运行时 JSON.parse 还原原始脚本文本，再交给 Function 在 __context__ 作用域运行。
            const encoded = JSON.stringify(node.textContent)
            node.textContent = `new Function("with(self.__context__){"+JSON.parse(${encoded})+"}").call(self.__context__)()`
          }
        }
      }
    }
    return node
  }

  const transformHtml = (html, root) => {
    const childs = html2dom(html, root)
    const doc = document.createDocumentFragment()
    for (const child of childs) {
      doc.appendChild(child)
    }
    html = Array.from(doc.childNodes).map(child => child.outerHTML).join('')
    html = html.replaceAll('&amp;amp;', '&amp;')
    return html
  }

  const reStyleUrl = /url\(["']?(http|\/\/)[^"')]+/g
  const reStyleImport = /@import\s["'](http|\/\/)[^"']+/g
  const reCssUrlWrap = /url\(([^\)]+)\)/g
  const reCssUrlStrip = /^url\(["']?|["']?\)$/g

  const transformStyleNode = (node) => {
    let text = node.textContent
    const matches = [
      ...new Set(text.match(reStyleUrl)),
      ...new Set(text.match(reStyleImport))
    ]
    const dict = {}
    matches.filter(m => {
      return !m.includes('\n') && m.indexOf(httpVpnDomain) < 0 && m.indexOf(httpsVpnDomain) < 0
    }).forEach(match => {
      let url = ''
      let prefix = ''
      let quote = ''
      if (match.slice(0, match.indexOf('//')).indexOf('http') >= 0) {
        // 同 replaceMatches：正则 [^"')]+ 已不含尾部分隔符，slice(..., -1) 会截掉 URL 末尾字符
        url = match.slice(match.indexOf('http'))
        prefix = url.startsWith('https') ? 'https://' : 'http://'
      } else {
        url = webvpn.protocol + match.slice(match.indexOf('//'))
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
      let host
      try { host = new URL(url).host } catch { return }
      const source = prefix + host
      const value = transformUrl(source.startsWith('http') ? source : (webvpn.protocol + source))
      dict[quote + source] = quote + value
    })
    Object.entries(dict).sort((a, b) => b[0].length - a[0].length).forEach(ele => {
      const [key, value] = ele
      text = text.replaceAll(key, () => value)
    })
    node.textContent = text
  }

  const decodeUrlInHtml = (html) => {
    /* TODO 先不管 srcset data codebase 之类的 */
    const urls = new Set()
    Array.from(html.matchAll(/(href|src|poster|action)="([^"]*)"/g)).forEach(match => {
      if (match[2].includes(httpVpnDomain) || match[2].includes(httpsVpnDomain)) urls.add(match[2])
    })
    if (urls.size) {
      Array.from(urls).sort((a, b) => b.length - a.length).forEach(url => {
        html = html.replaceAll(url, () => decodeUrl(url))
      })
    }
    return html
  }

  const getNodeUrl = (node) => {
    if (!node.getAttribute) return ['', '']
    let url = ''
    let urlAttr = ''
    for (const attr of urlAttrs) {
      url = (node.getAttribute(attr, 'custom') || '').trim()
      urlAttr = attr
      if (url) break
    }
    return [url, urlAttr]
  }

  const replaceNodesUrls = (root) => {
    const type = root ? undefined : 'custom'
    root = root || document.documentElement
    // document.open() 重置文档 / 文档销毁的瞬间 documentElement 为 null，而 window 定时器仍在运行
    if (!root || root.nodeType !== 1) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false)
    const all = []
    let n = null
    while (n = walker.nextNode()) {
      const name = getNodeName(n)
      if (linkTags.includes(name)) {
        n.node_name = name
        all.push(n)
      }
    }
    all.forEach((node) => {
      const attrs = nodeNameAttrsMap[node.node_name]
      if (!attrs) {
        replaceNodeUrl(root, node, null, type)
        return 
      }
      attrs.forEach(attr => replaceNodeUrl(root, node, attr, type))
    })
  }

  const replaceNodeUrl = (root, node, attr, type) => {
    let url = ''
    let urlAttr = ''
    if (attr) {
      url = node.getAttribute(attr, 'custom')
      urlAttr = attr
    } else {
      const link = getNodeUrl(node)
      url = link[0]
      urlAttr = link[1]
    }
    if (!checkUrlShouldReplace(url, attr)) return 
    let newUrl = transformUrl(url)
    if (attr === 'srcset') {
      let parts = url.split(/(\n|,|\s+)/g)
      const symbols = [' ', ',', '']
      parts = parts.map(function (part) {
        if (symbols.includes(part) || /^\dx$/.test(part)) return part
        return transformUrl(part)
      })
      newUrl = parts.join('')
    }
    if (newUrl !== url) {
      const tag = node.node_name
      if (root || tag !== 'script') {
        node.setAttribute(urlAttr, newUrl, type)
      } else {
        const copy = node.cloneNode(true)
        copy.src = newUrl
        node.parentNode.appendChild(copy)
        node.remove()
      }
    }
  }

  const checkUrlShouldReplace = (url, attr) => {
    url = (url || '').trim()
    if (!url) return false
    if (attr === 'srcset') return !!url
    for (const prefix of ignoredPrefixes) {
      if (url.startsWith(prefix)) return false
    }
    const vpnDomain = url.startsWith('https://') ? httpsVpnDomain : httpVpnDomain
    return url.indexOf(vpnDomain) < 0
  }

  const urljoin = (url, path) => {
    const { origin, pathname } = new URL(url)
    if (path[0] === '/') return origin + path
    if (url.endsWith('/')) return url + path
    return url.split('/').slice(0, -1).join('/') + '/' + path
  }

  const getNodeName = (node) => {
    return (node.nodeName || node.tagName || '').toLowerCase()
  }

  const domLog = (node, funcName) => {
    const link = getNodeUrl(node)[0]
    if (link) {
      console.log(
        '%cDOM 操作 拦截 ' + funcName + ' : ' + node.nodeName.toLowerCase() + ' - ' + link,
        'color: #606666;background-color: yellow;padding: 5px 10px;'
      )
      domUrls.push(link)
    }
  }

  const srcLog = (tag, urlAttr, url) => {
    console.log(
      '%cDOM 操作 拦截 ' + tag + ' ' + urlAttr + ' : ' + url,
      'color: #606666;background-color: lime;padding: 5px 10px;'
    )
  }

  /* Object.assign 拦截 */
  const _assign = Object.assign
  Object.assign = function (target, ...sources) {
    target = _assign.apply(Object, [target, ...sources])
    if (sources.includes(__location__)) {
      const props = Object.getOwnPropertyNames(__location__)
      props.forEach(prop => {
        const desc = Object.getOwnPropertyDescriptor(__location__, prop)
        if (desc.get) target[prop] = desc.get()
      })
    }
    return target
  }

  /* Function 拦截
     AST 模式（rewriteThis=true）：用 WASM 对 code 做 AST 改写，不包裹 with、不 bind。
       改写后的代码直接用 __location__/__window__ 等全局标识符（由 redefineGlobals
       定义在 window 上），Function 作用域可访问。this 由 AST 改写为
       (this === self ? __self__ : this)，不需 bind。
     旧模式：with(__self__.__context__) 包裹 + bind(__context__)，与原版完全一致。 */
  const _Function = window.Function
  if (webvpn.rewriteThis && __wasmRewrite) {
    window.Function = new Proxy(_Function, {
      construct (target, props) {
        if (props.length) {
          const code = props[props.length - 1]
          if (typeof code === 'string') {
            const rewritten = __wasmRewrite.rewrite(code)
            if (rewritten !== null) props[props.length - 1] = rewritten
          }
        }
        return new _Function(...props)
      },
      apply (target, thisArg, props) {
        if (props.length) {
          const code = props[props.length - 1]
          if (typeof code === 'string') {
            const rewritten = __wasmRewrite.rewrite(code)
            if (rewritten !== null) props[props.length - 1] = rewritten
          }
        }
        return new _Function(...props)
      }
    })
  } else {
    window.Function = new Proxy(_Function, {
      construct (target, props) {
        let isWithThis = false
        if (props.length) {
          const code = props[props.length - 1]
          isWithThis = code.includes('with(this === self ? __self__ : this)') || /[\s\{\}\;]?with\s*\(\s*this\s*\)/.test(code)
          if (isWithThis) {
            props[props.length - 1] = code.replace(/[\s\{\}\;]?with\s*\(\s*this\s*\)/g, ' with(this === self ? __self__ : this)')
          } else {
            props[props.length - 1] = `with (__self__.__context__) { ${code || ''} }`
          }
        }
        const func = new _Function(...props)
        return isWithThis ? func : func.bind(__context__)
      },
      apply (target, thisArg, props) {
        let isWithThis = false
        if (props.length) {
          const code = props[props.length - 1]
          isWithThis = code.includes('with(this === self ? __self__ : this)') || /[\s\{\}\;]?with\s*\(\s*this\s*\)/.test(code)
          if (isWithThis) {
            props[props.length - 1] = code.replace(/[\s\{\}\;]?with\s*\(\s*this\s*\)/g, ' with(this === self ? __self__ : this)')
          } else {
            props[props.length - 1] = `with (__self__.__context__) { ${code || ''} }`
          }
        }
        const func = new _Function(...props)
        return isWithThis ? func : func.bind(__context__)
      }
    })
  }

  /* eval 拦截：仅 AST 模式（rewriteThis=true）。
     旧模式下 eval 不拦截——with(__context_proxy__) 在运行时拦截裸标识符，
     且 eval 在调用者作用域执行，with 作用域对 eval 内的代码生效。
     AST 模式取消了 with，eval 代码里的 location/window 等裸标识符拿不到代理值。
     用 WASM 对 eval 代码做 AST 改写后交给原始 eval 执行。

     已知限制：_eval.call(window, code) 是间接 eval，在全局作用域执行，
     不保留直接 eval 的调用者作用域语义（无法访问局部变量）。
     这是拦截 eval 的固有限制——无法既拦截 eval 又保留直接 eval 作用域。
     this 不受影响——eval 继承调用者的 this，已由外层 AST 改写。 */
  if (webvpn.rewriteThis && __wasmRewrite) {
    const _eval = window.eval
    window.eval = function eval (code) {
      if (typeof code === 'string' && __wasmRewrite) {
        const rewritten = __wasmRewrite.rewrite(code)
        if (rewritten !== null) code = rewritten
        /* 解析失败（返回 null）时原样执行，不破坏功能 */
      }
      return _eval.call(window, code)
    }
  }

  /* EventSource 拦截 */
  const _EventSource = window.EventSource
  window.EventSource = new Proxy(_EventSource, {
    construct (target, [url, configuration]) {
      url = transformUrl(url)
      console.log('%cEventSource 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
      return new _EventSource(url, configuration)
    }
  })

  /* ajax 拦截 */
  const xhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, async = true, user, password) {
    const newUrl = transformUrl(url)
    console.log('%cAJAX 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
    ajaxUrls.push(url)
    return xhrOpen.bind(this)(method, newUrl, async, user, password)
  }

  /* fetch 拦截 */
  const fetch = window.fetch
  window.fetch = function (input, init) {
    if (input instanceof URL) input = input.href
    const isInputUrl = typeof input === 'string'
    const url = isInputUrl ? input : input.url
    const newUrl = transformUrl(url)
    console.log('%cfetch 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
    fetchUrls.push(url)
    if (isInputUrl) {
      input = newUrl
    } else {
      const reqInit = {}
      for (let key in input) {
        const value = input[key]
        if (key === 'url' || typeof value === 'function') continue
        reqInit[key] = value
      }
      input = new Request(newUrl, reqInit)
    }
    return fetch(input, init)
  }

  /* WebSocket 拦截 */
  const _WebSocket = window.WebSocket
  window.WebSocket = new Proxy(_WebSocket, {
    construct (target, props) {
      console.log('%cWebSocket 拦截 : ' + props[0], 'color: white;background-color: orange;padding: 5px 10px;')
      props[0] = transformUrl(props[0])
      return new _WebSocket(...props)
    },
    apply (target, thisArg, props) {
      console.log('%cWebSocket 拦截 : ' + props[0], 'color: white;background-color: orange;padding: 5px 10px;')
      props[0] = transformUrl(props[0])
      return new _WebSocket(...props)
    }
  })

  /* dom 操作拦截 */

  /* appendChild 拦截 */
  function appendChild_wrap (func) {
    return function (node) {
      if (!(node instanceof Node)) return
      if (node._type_ !== 'custom') {
        domLog(node, 'appendChild')
        node = transformNode(node)
      }
      return func.call(this, node)
    }
  }
  Node.__appendChild__ = Node.prototype.appendChild
  Node.prototype.appendChild = appendChild_wrap(Node.__appendChild__)

  /* insertBefore 拦截 */
  function insertBefore_wrap (func) {
    return function (node, sibling) {
      domLog(node, 'insertBefore')
      node = transformNode(node)
      return func.bind(this)(node, sibling)
    }
  }
  Node.__insertBefore__ = Node.prototype.insertBefore
  Node.prototype.insertBefore = insertBefore_wrap(Node.__insertBefore__)

  /* replaceChild 拦截 */
  function replaceChild_wrap (func) {
    return function (node, oldNode) {
      domLog(node, 'replaceChild')
      node = transformNode(node)
      return func.bind(this)(node, oldNode)
    }
  }
  Node.__replaceChild__ = Node.prototype.replaceChild
  Node.prototype.replaceChild = replaceChild_wrap(Node.__replaceChild__)

  function nodesMethod_wrap (func, name) {
    return function () {
      const nodes = arguments
      transformArgumentsNodes(nodes, name)
      return func.apply(this, nodes)
    }
  }
  Array.from(['replaceChildren', 'prepend', 'append', 'before', 'after']).forEach((name) => {
    const origin = Element.prototype[name]
    Element['__' + name + '__'] = origin
    Element.prototype[name] = nodesMethod_wrap(origin, name)
  })

  Array.from(['replaceChildren', 'append', 'prepend']).forEach((name) => {
    const origin = DocumentFragment.prototype[name]
    DocumentFragment['__' + name + '__'] = origin
    DocumentFragment.prototype[name] = nodesMethod_wrap(origin, name)
  })

  /* setAttribute 拦截 */
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (attr, value, type) {
    if (type !== 'custom' && urlAttrs.includes(attr)) {
      console.log(
        '%cDOM 操作 拦截 setAttribute : ' + this.nodeName.toLowerCase() + ' - ' + attr + ' - ' + value,
        'color: #606666;background-color: lime;padding: 5px 10px;'
      )
      value = transformUrl(value)
    }
    return setAttribute.bind(this)(attr, value)
  }

  /* insertAdjacentHTML 拦截 */
  function insertAdjacentHTML_wrap (func) {
    return function (position, html) {
      console.log(
        '%cDOM 操作 拦截 insertAdjacentHTML : ' + html,
        'color: #606666;background-color: lime;padding: 5px 10px;'
      )
      html = transformHtml(html, this)
      return func.bind(this)(position, html)
    }
  }
  Element.__insertAdjacentHTML__ = Element.prototype.insertAdjacentHTML
  Element.prototype.insertAdjacentHTML = insertAdjacentHTML_wrap(Element.__insertAdjacentHTML__)

  /* insertAdjacentElement 拦截 */
  function insertAdjacentElement_wrap (func) {
    return function (position, node) {
      console.log(
        '%cDOM 操作 拦截 insertAdjacentElement : ',
        'color: #606666;background-color: lime;padding: 5px 10px;'
      )
      node = transformNode(node)
      return func.bind(this)(position, node)
    }
  }
  Element.__insertAdjacentElement__ = Element.prototype.insertAdjacentElement
  Element.prototype.insertAdjacentElement = insertAdjacentElement_wrap(Element.__insertAdjacentElement__)

  /* a 元素 click 拦截 */
  const aOnClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    console.log(
      '%cDOM History 操作 拦截 a click : ' + this.href,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(this.href)) return false
    return aOnClick.apply(this, arguments)
  }

  /* document.URL */
  Object.defineProperty(document, 'URL', {
    get () {
      return webvpn.currentHref
    }
  })

  /* document.domain */
  Object.defineProperty(document, 'domain', {
    get () {
      return webvpn.target.hostname
    },
    set (value) {
      console.log('%cset document.domain: ' + value, 'background-color: red; color: white; padding: 5px 10px;')
    }
  })

  Object.defineProperty(document, 'baseURI', {
    get () {
      return webvpn.currentHref
    }
  })

  Object.defineProperty(HTMLElement.prototype, 'baseURI', {
    get () {
      return webvpn.currentHref
    }
  })

  /* TODO TODO 目前发现部分网站自定义了 cookie descriptor，会出现错误 */
  if (Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')) {
    Object.defineProperty(Document.prototype, 'cookie', { configurable: false })
  }
  if (Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie')) {
    Object.defineProperty(HTMLDocument.prototype, 'cookie', { configurable: false })
  }

  /* TODO TODO createTask 有问题？？？ */
  const _createTask = console.createTask
  delete console.createTask

  /* document.referrer */
  const _referrer = decodeUrl(document.referrer.includes(webvpn.siteUrl) ? (location.origin + '/') : document.referrer)
  Object.defineProperty(document, 'referrer', {
    get () {
      return _referrer
    }
  })

  /* open 拦截 */
  const open = window.open
  window.open = function (url, name, specs, replace) {
    console.log(
      '%copen 拦截 : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(url)) return false
    url = transformUrl(url)
    return open.bind(window)(url, name, specs, replace)
  }

  /* go 拦截 */
  const go = History.prototype.go
  History.prototype.go = function (value) {
    // parseInt('100px')===100 会误判为数字索引；改用严格整数字符串判断
    if (!/^-?\d+$/.test(value + '')) {
      console.log(
        '%cHistory 操作 拦截 go : ' + value,
        'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
      )
      value = transformUrl(value)
    }
    if (!canJump(value)) return false
    return go.apply(this, [value])
  }

  /* _navigate 拦截 */
  window.location._navigate = function (url) {
    console.log(
      '%c_navigate 拦截 : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (isBlankNav(url)) return false
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.navigate(url)
  }
  window.location.__navigate__ = window.location._navigate

  /* location _assign 拦截 */
  window.location._assign = function (url) {
    console.log(
      '%clocation 操作 拦截 _assign : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (isBlankNav(url)) return false
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.location.assign(url)
  }
  window.location.__assign__ = window.location._assign

  /* location _replace 拦截 */
  window.location._replace = function (url) {
    console.log(
      '%clocation 操作 拦截 _replace : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (isBlankNav(url)) return false
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.location.replace(url)
  }
  window.location.__replace__ = window.location._replace

  /* location reload */
  window.location._reload = function () {
    if (!canJump(location.href)) return false
    return window.location.reload()
  }
  window.location.__reload__ = window.location._reload

  /* location toString */
  window.location._toString = function () {
    return window.location.__href__
  }
  window.location.__toString__ = window.location._toString

  function redefineGlobals (win) {
    if (!webvpn.target) defineWebvpnLocation()
    /* window.__location__ */
    if (!Object.keys(win.location).length) return
    win.__location__ = {}
    // 缓存 decodeUrl 后的 URL 对象：原实现每次属性访问都 new URL，且 getter 内
    // key = key.replaceAll('__','') 会修改闭包变量，逻辑脆弱。改为按 href 失效缓存，
    // 用独立的 attr 常量避免闭包变量被修改。
    let cachedHref = null
    let cachedUrl = null
    const getParsedUrl = () => {
      const href = win.location.href
      if (href !== cachedHref) {
        cachedHref = href
        try { cachedUrl = new URL(decodeUrl(href)) } catch { cachedUrl = null }
      }
      return cachedUrl
    }
    locationAttrs.forEach(attr => {
      win.location['__' + attr + '__'] = webvpn.target[attr]
      for (const name of [attr, '__' + attr + '__']) {
        Object.defineProperty(win.__location__, name, {
          get () {
            const u = getParsedUrl()
            if (u && attr in u) return u[attr]
            return webvpn.target[attr] || location[attr]
          },
            set (value) {
              if (attr === 'href') {
                console.log(
                  '%c__location__ 拦截 href : ' + value,
                  'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
                )
                if (isBlankNav(value)) return false
                if (!canJump(value)) return false
              value = transformUrl(value)
              win.location.href = value
            } else {
              win.location[attr] = value
            }
            return true
          }
        })
      }
    })
    for (let key of ['navigate', 'assign', 'replace', 'reload', 'toString']) {
      win.__location__[key] = win.location['_' + key]
      win.__location__['__' + key + '__'] = win.location['_' + key]
    }

    /* 启动时快照原生方法。站点代码全部经 __document__ 代理读写，这里按「形态」区分两类替换：
       - masked 包装（Proxy / bind 结果，Function.prototype.toString 被 V8 掩饰为 [native code]）：
         反调试典型手法，apply trap 常丢弃 this，调用即抛 Illegal invocation → 恢复原生；
       - 源码可见的普通函数包装（function () { return orig.apply(this, arguments) }）：
         站点合法 monkey-patch 的常见形态 → 放行（仅修正 this），否则站点自己的补丁被吞、功能损坏。
       每个窗口各自快照，保证 iframe 场景绑定正确的 document。遍历整条原型链取全部函数值属性
       （覆盖 createScript 等全部工厂/查询方法），仅跳过本脚本包装过的方法（ownWrappedMethods，
       恢复它们等于拆除自身拦截）。用描述符判断而不直接读取属性，避免触发 getter。 */
    const nativeMethods = new Map()
    const boundMethods = new Map()
    try {
      /* 只从原型链取（document 自身属性在 init 时只有存取器，且可能已被抢先污染） */
      let docProto = Object.getPrototypeOf(win.document)
      while (docProto && docProto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(docProto)) {
          try {
            if (ownWrappedMethods.includes(key) || nativeMethods.has(key)) continue
            const desc = Object.getOwnPropertyDescriptor(docProto, key)
            const fn = desc && desc.value
            if (typeof fn === 'function' && !fn.prototype) {
              nativeMethods.set(key, fn)
              /* 预绑定 + 还原 name：原生 DOM 方法有品牌检查（receiver 必须是真实 document），
                 经代理调用必须 bind；缓存同一副本保证每次 get 返回值恒定，name 不带 "bound " 前缀 */
              const bound = fn.bind(win.document)
              try { Object.defineProperty(bound, 'name', { value: fn.name }) } catch {}
              boundMethods.set(key, bound)
            }
          } catch {}
        }
        docProto = Object.getPrototypeOf(docProto)
      }
    } catch {}

    /* window 侧快照：__window__/__parent__/__top__ 代理与 __document__ 共用 get trap，
       但不能用 document 的方法映射——window 与 document 存在大量同名方法（open/close/
       dispatchEvent…），语义完全不同，混用会把 __window__.open 劫持成 document.open
       （1 参调用按 HTML 规范直接清空当前文档，站点弹窗全部失效且页面变空白）。
       Window 的 WebIDL 成员在 Chrome 是实例自有属性（Window.prototype 上没有 open），
       因此自有属性与原型链都要快照。快照时本脚本已安装的 window 包装（fetch/open 等）
       一并捕获，代理返回它们的绑定副本恰好保持拦截语义。 */
    const winNativeMethods = new Map()
    const winBoundMethods = new Map()
    try {
      const sources = [win]
      let winProto = Object.getPrototypeOf(win)
      while (winProto && winProto !== Object.prototype) {
        sources.push(winProto)
        winProto = Object.getPrototypeOf(winProto)
      }
      for (const src of sources) {
        for (const key of Object.getOwnPropertyNames(src)) {
          try {
            if (ownWrappedMethods.includes(key) || winNativeMethods.has(key)) continue
            const desc = Object.getOwnPropertyDescriptor(src, key)
            const fn = desc && desc.value
            if (typeof fn === 'function' && !fn.prototype) {
              winNativeMethods.set(key, fn)
              const bound = fn.bind(win)
              try { Object.defineProperty(bound, 'name', { value: fn.name }) } catch {}
              winBoundMethods.set(key, bound)
            }
          } catch {}
        }
      }
    } catch {}

    /* 初始化清扫：若有脚本抢在注入块之前（raw 路径，如 eval / CDP 预注入）把方法槽位替换成
       masked 包装，这里一次性还原为绑定原生，raw 直读路径同样安全；
       源码可见的普通函数包装视为站点合法 patch，保留不动。 */
    try {
      for (const [key, fn] of nativeMethods) {
        const desc = Object.getOwnPropertyDescriptor(win.document, key)
        if (!desc || !desc.configurable || desc.get || desc.value === fn) continue
        if (typeof desc.value !== 'function') continue
        let masked = true
        try { masked = Function.prototype.toString.call(desc.value).includes('[native code]') } catch {}
        if (masked) Object.defineProperty(win.document, key, { value: boundMethods.get(key), writable: true, configurable: true })
      }
    } catch {}

    for (const con of globalCons) {
      if (
        con === 'globalThis'
        || con === 'parent' && window === parent
        || con === 'self'
        || con === 'top' && window === top
      ) {
        win['__' + con + '__'] = win.__window__
        continue
      }
      win['__' + con + '__'] = new Proxy(win[con], {
        get (obj, property, receiver) {
          const w = (obj === parent || obj === top) ? obj : win
          if (globalCons.includes(property) || property === 'location') {
            return w['__' + property + '__']
          }
          const value = obj[property]
          if (typeof value === 'function') {
            if (property === 'fetch') return window.fetch
            // Proxy 不变量：target 自身不可配置且不可写的数据属性必须原样返回，返回 bind 副本会抛
            // "'get' on proxy: property 'xxx' is a read-only and non-configurable data property…" TypeError
            try {
              const desc = Object.getOwnPropertyDescriptor(obj, property)
              if (desc && desc.configurable === false && desc.writable === false) return value
            } catch {}
            // window 与 document 各用各的方法快照：open/close/dispatchEvent 等同名方法在
            // 两边语义不同，__window__ 用 document 的映射会把 open 劫持成 document.open
            const isWinObj = obj === obj.window
            const nativeMap = isWinObj ? winNativeMethods : nativeMethods
            const boundMap = isWinObj ? winBoundMethods : boundMethods
            const native = nativeMap.get(property)
            if (native !== undefined) {
              // document 方法槽位：未篡改 → 返回预绑定副本（this 恒为真实 document）
              if (native === value) return boundMap.get(property)
              // 被替换过：toString 为 [native code] 的是 Proxy/bind 包装（反调试形态，apply trap
              // 常丢弃 this）→ 恢复原生；源码可见的普通函数包装是站点合法 monkey-patch →
              // 放行并修正 this，不能吞掉站点的补丁
              let masked = true
              try { masked = Function.prototype.toString.call(value).includes('[native code]') } catch {}
              if (masked) return boundMap.get(property)
              return value.bind(obj)
            }
            // 非方法槽位：带 prototype 的值是构造器/类（如 Promise、站点自定义类），bind 会丢
            // 静态属性，原样返回；其余（箭头函数等）bind 修正 this
            if (value.prototype) return value
            return value.bind(obj)
          }
          return value
        },
        set (obj, property, value) {
          if (property === 'window') return false
          if (property === 'location') {
            if (isBlankNav(value)) return true
            const url = transformUrl(value)
            if (obj === parent || obj === top) {
              obj.location = url
              return true
            }
            console.log(
              '%clocation 操作 拦截 location = : ' + value,
              'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
            )
            if (!canJump(value)) return true
            win.location.href = url
          }
          // document 方法槽位的函数赋值：masked 包装（Proxy/bind，toString 为 [native code]，
          // 反调试手法）替换为绑定原生再落库，raw 直读路径不被污染；源码可见的普通函数包装
          // 是站点合法 monkey-patch，原样放行
          if (obj === win.document && typeof value === 'function') {
            const native = nativeMethods.get(property)
            if (native !== undefined && native !== value) {
              let masked = true
              try { masked = Function.prototype.toString.call(value).includes('[native code]') } catch {}
              if (masked) value = boundMethods.get(property)
            }
          }
          obj[property] = value
          return true
        }
      })
    }
    /* 统一 document 身份：站点可见的 document 恒为 __document__ 代理（伪造 document.location
       所必需），而节点的 ownerDocument 仍指向真实 document，两份身份并存会让按 document 对象
       做身份比较 / 内部缓存的站点库（jQuery/Sizzle 等）在两者间反复重置内部状态，委托事件、
       选择器匹配随之失效。这里把节点树上指向真实 document 的 ownerDocument 一律映射到同一代理
       （document 自身仍为 null，iframe、DOMParser 等其他 document 不受影响），
       站点侧从此只存在一个 document 对象。 */
    try {
      const docProxy = win.__document__
      const rawOwnerDocument = Object.getOwnPropertyDescriptor(win.Node.prototype, 'ownerDocument').get
      Object.defineProperty(win.Node.prototype, 'ownerDocument', {
        get () {
          const doc = rawOwnerDocument.call(this)
          return doc === win.document ? docProxy : doc
        },
        configurable: true
      })
    } catch {}

    win.__context__ = {
      self: win.__self__,
      window: win.__window__,
      document: win.__document__,
      globalThis: win.__globalThis__,
      parent: win.__parent__,
      top: win.__top__,
      location: win.__location__
    }
    win.__context_proxy__ = new Proxy(win.__context__, {
      has (target, prop) {
        return true
      },
      get (target, prop) {
        return prop in target ? target[prop] : win[prop]
      },
      set (target, prop, value) {
        // with 作用域内的 location = 'xxx' 会落到 win.location 触发立即导航，同样拦截 about:blank
        if (prop === 'location' && isBlankNav(value)) return true
        win[prop] = value
        return true
      }
    })
    return win
  }

  redefineGlobals(window)

  /* 目标网站的反调试常用 Object.defineProperty(document, 'createElement', { writable: false, configurable: false })
     锁定原生方法。一旦锁定，__document__ 代理的 get trap 无法再返回 bind 副本（Proxy 不变量要求
     非 writable 且非 configurable 的自有数据属性必须原样返回，否则抛
     "'get' on proxy: property 'createElement' is a read-only and non-configurable data property…"），
     整站脚本随之崩溃。这里把针对 document / window 自身的数据属性锁强制改为 configurable，
     使锁失效；属性值不变，不感知锁存在的正常网站不受影响。Document.prototype 上的锁（如 cookie）不在此列。 */
  const rawDefineProperty = Object.defineProperty
  const keepConfigurable = (target, desc) => {
    try {
      if ((target === document || target === window) && desc && typeof desc === 'object' && desc.configurable === false) {
        // document 槽位不预绑定：站点经 defineProperty 安装的函数值可能是合法 patch，
        // 保留原值，交给 __document__ get trap 按形态判定（masked 恢复原生 / 可见包装放行）；
        // 若在这里 bind，值被掩饰成 native 形态，get trap 会把它当反调试包装恢复掉，补丁失效
        if (target === document) {
          desc = Object.assign({}, desc, { configurable: true })
        } else if (typeof desc.value === 'function' && !desc.value.prototype) {
          // window 函数值预绑定为真实对象：即使包装值被写入（如经其他 realm 的 defineProperty），
          // 调用时 this 也是真实对象，不会抛 Illegal invocation
          const bound = desc.value.bind(target)
          try { Object.defineProperty(bound, 'name', { value: desc.value.name }) } catch {}
          desc = Object.assign({}, desc, { configurable: true, value: bound })
        } else {
          desc = Object.assign({}, desc, { configurable: true })
        }
      }
    } catch {}
    return desc
  }
  Object.defineProperty = function (target, key, desc) {
    return rawDefineProperty.call(Object, target, key, keepConfigurable(target, desc))
  }
  if (window.Reflect && Reflect.defineProperty) {
    const rawReflectDefineProperty = Reflect.defineProperty
    Reflect.defineProperty = function (target, key, desc) {
      return rawReflectDefineProperty.call(Reflect, target, key, keepConfigurable(target, desc))
    }
  }

  /* 不做「预绑定 + 不可写/不可配置」硬锁定：站点的合法 monkey-patch（替换 document 方法）
     必须能落地，锁死会让这类网站直接 TypeError 坏掉。防线改为按形态拦截——
     masked 包装（Proxy/bind，toString 为 [native code]，反调试手法）在快照清扫、
     set trap、get trap 三处被还原为原生；源码可见的普通函数包装一律放行。 */

  // 此前对 window 上所有函数属性执行 window[key] = window[key].bind(window)：
  // 1) for...in 会遍历继承属性；2) bind 后函数 name 变为 "bound xxx"，破坏依赖 fn.name 的代码；
  // 3) 不可写 / 不可配置的属性（如 eval、alert 等很多原生方法）赋值会静默失败或严格模式抛错。
  // 改为：用 Object.keys 仅遍历自身可枚举属性，检查描述符可写后再赋值。
  for (const key of Object.keys(window)) {
    try {
      const desc = Object.getOwnPropertyDescriptor(window, key)
      if (!desc || !desc.writable || desc.get || desc.set) continue
      const fn = window[key]
      if (typeof fn !== 'function' || fn.name.startsWith('bound ')) continue
      // 只 bind 原生方法（修正 detach 调用的 this）。源码可见的普通函数（本脚本或站点装的
      // 包装）不需要 this 修正，而 bind 会把它掩饰成 [native code] 形态，污染 get/set trap
      // 的 masked 判定——window.open 包装曾被这里 bind 成 masked，随后 __window__.open 被
      // 误判为反调试包装劫持成 document.open，弹窗全失效。
      let masked = true
      try { masked = Function.prototype.toString.call(fn).includes('[native code]') } catch {}
      if (!masked) continue
      const bound = fn.bind(window)
      // 尽量保留原 name，减少对依赖 fn.name 的代码的破坏
      try { Object.defineProperty(bound, 'name', { value: fn.name }) } catch {}
      window[key] = bound
    } catch {}
  }

  // 检查 __context__.location 是否被赋值为字符串（导航意图），是则执行跳转。
  // 与 scheduleScan 一样做成 visibility-aware：页面隐藏时降频，卸载时停止，避免空转耗电。
  let locTimer = null
  let locStopped = false
  let locDelay = 500
  const checkContextLocation = () => {
    if (locStopped) return
    const location = window.__context__.location
    if (typeof location === 'string') {
      window.location.href = transformUrl(location)
    }
    locDelay = document.hidden ? 5000 : 500
    locTimer = setTimeout(checkContextLocation, locDelay)
  }
  checkContextLocation()
  window.addEventListener('beforeunload', () => { locStopped = true; clearTimeout(locTimer) })

  /* 因为用 __document__ 替换了 document, __document__ 的时候类型跟 document 不一致 */
  const observe = MutationObserver.prototype.observe
  MutationObserver.prototype.observe = function (obj, options) {
    if (obj == window.__document__) obj = document
    return observe.bind(this)(obj, options)
  }

  /* getAttribute 拦截 */
  const nasUnion = []
  for (const item of nodeAttrSetters) {
    const ele = nasUnion.find(ele => ele[0] === item[0])
    if (!ele) {
      nasUnion.push([item[0], item[1], [item[2]]])
    } else {
      ele[2].push(item[2])
    }
  }
  nasUnion.forEach((item) => {
    const getAttribute = item[0].prototype.getAttribute
    item[0].prototype.getAttribute = function (attr, type) {
      let value = getAttribute.bind(this)(attr)
      if (value && (value.startsWith('http') || value.startsWith('//')) && type !== 'custom' && item[2].includes(attr)) {
        console.log(
          '%cDOM 操作 拦截 getAttribute : ' + item[1] + ' - ' + attr + ' ' + value,
          'color: #606666;background-color: lime;padding: 5px 10px;'
        )
        value = decodeUrl(value)
      }
      return value
    }
  })

  /* Worker 创建拦截 */
  const _Worker = window.Worker
  window.Worker = function (url, options) {
    console.log(
      '%cnew 拦截 Worker : ' + url,
      'color: #606666;background-color: lime;padding: 5px 10px;'
    )
    url = transformUrl(url)
    if (url.startsWith('blob:') && blobs[url]) {
      const blob = blobs[url]
      if (typeof blob.part[0] === 'string') {
        const targetUrl = 'blob:' + (/\/\//.test(url) ? decodeUrl(url) : url)
        const code = webvpn.worker_wrapper_code.replace('#targetUrl#', targetUrl).replace('#CODE#', blob.part[0])
        const _blob = new window._Blob_([code], blob.options)
        url = URL._createObjectURL_(_blob)
      }
    }
    return new _Worker(url, options)
  }

  /* ServiceWorkerContainer register 拦截 */
  if (window.ServiceWorkerContainer) {
    const register = window.ServiceWorkerContainer.prototype.register
    window.ServiceWorkerContainer.prototype.register = function (url, options) {
      console.log(
        '%cServiceWorkerContainer 操作 拦截 register : ' + url,
        'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
      )
      url = transformUrl(url)
      return register.call(this, url, options)
    }
  }

  /* pushState replaceState 拦截 */
  Array.from(['pushState', 'replaceState']).forEach((name) => {
    const origin = History.prototype[name]
    History.prototype[name] = function (state, title, url) {
      console.log(
        '%cHistory 操作 拦截 ' + name + ' : ' + url,
        'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
      )
      if (!canJump(url)) return false
      url = transformUrl(url)
      origin.bind(this)(state, title, url)
    }
  })

  const canJump = (url) => {
    // if (transformUrl(url).split(/(\?#)/)[0] === location.href.split(/(\?#)/)[0]) return false
    if (disableJump) return false
    if (confirmJump) {
      const ok = confirm('允许跳转到 ' + url + ' 吗？')
      if (!ok) return false
    }
    return true
  }

  // 顶层导航到 about:blank 会立刻摧毁代理会话，常见于目标网站反调试的惩罚跳转
  // （如检测到开发者工具后 location.href = 'about:blank'），正常业务几乎不会这样做，默认拦截。
  // 只拦顶层导航路径，不拦 window.open('about:blank')（创建空白弹窗是合法用法）。
  const isBlankNav = (url) => typeof url === 'string' && url.trim() === 'about:blank'

  nodeAttrSetters.forEach((item) => {
    let descriptor = Object.getOwnPropertyDescriptor(item[0].prototype, item[2])
    /* audio video 的 src 描述符没了，转到了 media 的描述符上 */
    if (!descriptor && ['audio', 'video'].includes(item[1]) && item[2] === 'src') {
      descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
    }
    Object.defineProperty(item[0].prototype, item[2], {
      get () {
        const value = descriptor.get.call(this) || ''
        console.log(
          '%cDOM 操作 拦截 ' + item[1] + ' ' + item[2] + ' getter : ' + value,
          'color: #606666;background-color: lime;padding: 5px 10px;'
        )
        if (!value || value.startsWith('blob:') || value.startsWith('javascript:')) return value
        return decodeUrl(value)
      },
      set (url) {
        srcLog(item[1], item[2], url)
        descriptor.set.call(this, transformUrl(url))
      }
    })
  })

  /* a 元素的 host 等 URL 属性 拦截, href 在上面的 get 函数里拦截了 */
  const aUrlAttrs = ['href', 'host', 'hostname', 'origin', 'port', 'protocol']
  aUrlAttrs.forEach((attr) => {
    Object.defineProperty(HTMLAnchorElement.prototype, attr, {
      get () {
        console.log(
          '%cDOM 操作 拦截 a ' + attr + ' getter',
          'color: #606666;background-color: lime;padding: 5px 10px;'
        )
        let url = this.getAttribute('href') || decodeUrl(location.href)
        if (ignoredPrefixes.some(prefix => url.startsWith(prefix))) return url
        if (!url.startsWith('http') && !url.startsWith('//')) {
          url = urljoin(webvpn.currentHref, url)
        }
        if (attr === 'href') return url
        try {
          return new URL(url)[attr]
        } catch {
          return url
        }
      }
    })
  })

  /* style.backgroundImage 拦截 */
  const sDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')
  Object.defineProperty(HTMLElement.prototype, 'style', {
    get () {
      const node = this
      const style = sDescriptor.get.call(this)
      return new Proxy(style, {
        get (target, property) {
          let value = target[property]
          if (typeof value === 'function') {
            return (...props) => value.apply(target, props)
          }
          return value
        },
        set (target, property, value) {
          if (property === 'background' || property === 'backgroundImage') {
            value = value.replace(reCssUrlWrap, text => {
              const url = text.replace(reCssUrlStrip, '')
              return text.replace(url, () => transformUrl(url))
            })
            console.log(
              '%cstyle 操作 拦截 ' + property + ' : ' + value,
              'color: #606666;background-color: lime;padding: 5px 10px;'
            )
          }
          target[property] = value
          return true
        }
      })
    }
  })

  /* 附注：这里只是拦截 CSS 操作，不知道所属哪个节点，如果想知道，可以放在上面，通过 style.cssText 拦截 */
  const ctDescriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')
  Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
    set (value) {
      let hasUrl = false
      value = value.replace(reCssUrlWrap, text => {
        hasUrl = true
        const url = text.replace(reCssUrlStrip, '')
        return text.replace(url, () => transformUrl(url))
      })
      hasUrl && console.log(
        '%cstyle 操作 拦截 cssText : ' + value,
        'color: #606666;background-color: lime;padding: 5px 10px;'
      )
      ctDescriptor.set.apply(this, [value])
    }
  })

  /* document.write 拦截 */
  const write = document.write
  document.write = function () {
    const htmls = []
    for (const html of arguments) {
      htmls.push(transformHtml(html, document.body))
    }
    console.log(
      '%cDOM 操作 拦截 document.write : ' + htmls,
      'color: #606666;background-color: lightblue;padding: 5px 10px;'
    )
    return write.apply(document, htmls)
  }

  /* document.writeln 拦截 */
  const writeln = document.writeln
  document.writeln = function () {
    const htmls = []
    for (const html of arguments) {
      htmls.push(transformHtml(html, document.body))
    }
    console.log(
      '%cDOM 操作 拦截 document.writeln : ' + htmls,
      'color: #606666;background-color: lightblue;padding: 5px 10px;'
    )
    return writeln.apply(document, htmls)
  }

  /*
    注意，已经没有真正的 innerHTML 方法了，原生的 innerHTML 不存在了
    现在的仅是通过创建节点，设置节点子节点、文本内容，没有设置 html 内容的功能
    innerHTML 拦截
  */
  const ihDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
  Object.defineProperty(Element.prototype, '__innerHTML__', {
    set: ihDescriptor.set
  })
  Object.defineProperty(Element.prototype, 'innerHTML', {
    get () {
      const html = ihDescriptor.get.call(this)
      return decodeUrlInHtml(html)
    },
    set (html) {
      html = (html || '').toString()
      // 拒绝清空整个文档的写入（如反调试脚本的惩罚逻辑），保护代理会话
      if (this === document.documentElement) {
        console.log(
          '%cDOM 操作 拦截 documentElement.innerHTML 清屏 : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
          'color: #606666;background-color: lightblue;padding: 5px 10px;'
        )
        return
      }
      const self = this instanceof HTMLTemplateElement ? this.content : this
      const childs = html2dom(html, self)
      console.log(
        '%cDOM 操作 拦截 innerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
        'color: #606666;background-color: lightblue;padding: 5px 10px;'
      )
      self.childNodes.forEach(child => child.remove())
      childs.forEach(child => {
        Node.__appendChild__.call(self, child)
      })
    }
  })

  /* outerHTML 拦截 */
  const ohDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')
  Object.defineProperty(Element.prototype, '__outerHTML__', {
    set: ohDescriptor.set
  })
  Object.defineProperty(Element.prototype, 'outerHTML', {
    get () {
      const html = ohDescriptor.get.call(this)
      return decodeUrlInHtml(html)
    },
    set (html) {
      html = (html || '').toString()
      const childs = html2dom(html, this)
      console.log(
        '%cDOM 操作 拦截 outerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
        'color: #606666;background-color: lightblue;padding: 5px 10px;'
      )
      const container = document.createElement(this.nodeName)
      for (const child of childs) {
        container.appendChild(child)
      }
      ohDescriptor.set.apply(this, [container.innerHTML])
    }
  })

  const fDescriptor = Object.getOwnPropertyDescriptor(window, 'frames')
  Object.defineProperty(window, 'frames', {
    get () {
      const frames = fDescriptor.get.apply(this, [])
      return new Proxy(frames, {
        get (obj, property, receiver) {
          const value = obj[property]
          if (!/^\d+$/.test(property)) return value
          redefineGlobals(value)
          return Object.assign({}, value, { ...value.__context__ })
        }
      })
    }
  })

  const cwDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get () {
      const cw = cwDescriptor.get.apply(this, [])
      if (!cw) return cw
      if (!redefineGlobals(cw)) return cw
      if (!cw.__win__) {
        cw.webvpn = {
          siteUrl: webvpn.siteUrl,
          protocol: webvpn.protocol,
          sourceUrl: webvpn.sourceUrl,
          pageUrl: webvpn.pageUrl,
          hostname: webvpn.hostname,
          base: webvpn.base,
          _js_injected__: false
        }
        cw.__win__ = new Proxy(cw, {
          get (obj, property, receiver) {
            let value = cw.__context__[property]
            if (!value) {
              value = cw[property]
              if (typeof value === 'function') {
                return (...props) => value.apply(cw, props)
              }
            }
            return value
          }
        })
      }
      return cw.__win__
    }
  })

  const cdDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    get () {
      try {
        const doc = this.contentWindow.__document__
        const win = this.contentWindow.window
        if (!win.webvpn._js_injected__) {
          win.eval(webvpn.intercept_code)
          win.webvpn._js_injected__ = true
        }
        return doc
      } catch {
        return null
      }
    }
  })

  const parser = new DOMParser()
  const html2dom = (html, root) => {
    const doc = parser.parseFromString(html, 'text/html')
    return Array.from(doc.body.childNodes)
  }

  const hasEscaped = (text, index) => {
    if (index === 1) return /&\w+/.test(text)
    if (index === 2) return /&#\d+;/.test(text)
    if (index === 3) return /&#x\w+;/.test(text)
  }

  window.addEventListener('load', replaceNodesUrls)
  setTimeout(replaceNodesUrls, 1000)
  setTimeout(replaceNodesUrls, 2000)
  // 此前是固定 setInterval(replaceNodesUrls, 3000) 永久运行，页面稳定后仍每 3s 全量遍历 DOM。
  // 改为：页面可见时每 3s 扫描一次，隐藏时拉长至 10s（节省后台 CPU），卸载时停止。
  let scanStopped = false
  let scanTimer = null
  const scheduleScan = () => {
    if (scanStopped) return
    clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      if (scanStopped) return
      replaceNodesUrls()
      scanDelay = document.hidden ? 10000 : 3000
      scheduleScan()
    }, scanDelay)
  }
  let scanDelay = 3000
  scheduleScan()
  window.addEventListener('beforeunload', () => { scanStopped = true; clearTimeout(scanTimer) })

  /* 事件绑定的 this 对象拦截替换 */
  const wael = window.addEventListener
  window.addEventListener = function () {
    if (arguments[0] === __window__) arguments[0] = window
    return wael.apply(window, arguments)
  }
  const wrel = window.removeEventListener
  window.removeEventListener = function () {
    if (arguments[0] === __window__) arguments[0] = window
    return wrel.apply(window, arguments)
  }
  const dael = document.addEventListener
  document.addEventListener = function () {
    if (arguments[0] === __document__) arguments[0] = document
    return dael.apply(document, arguments)
  }
  const drel = document.removeEventListener
  document.removeEventListener = function () {
    if (arguments[0] === __document__) arguments[0] = document
    return drel.apply(document, arguments)
  }

  const createTreeWalker = HTMLDocument.prototype.createTreeWalker
  HTMLDocument.prototype.createTreeWalker = function (node, ...props) {
    if (node === __document__) node = document
    return createTreeWalker.apply(document, [node, ...props])
  }

  window._Blob_ = window.Blob
  window.Blob = function (part, options) {
    const blob = new window._Blob_(part, options)
    blob.part = part
    blob.options = options
    return blob
  }

  URL._createObjectURL_ = URL.createObjectURL
  URL.createObjectURL = function (object) {
    const url = URL._createObjectURL_(object)
    blobs[url] = object
    return url
  }

  const logger = console.log
  console.log = function log () {
    const isCustom = arguments[0] === 'custom'
    const ignore = isCustom || typeof arguments[0] !== 'string'

    let title = ''
    let shouldLog = true
    if (!ignore && arguments.length === 2) {
      title = arguments[0].split(':')[0]
      title = title.indexOf('拦截') < 0 ? '' : title
      if (title) {
        shouldLog = logTypes.some((type) => title.indexOf(type) >= 0)
      }
    }
    // 仅在需要时归档日志：interceptLog 关闭且无插件消费 logs 时，跳过 groupLogs 避免无谓开销与内存增长
    if (title && (interceptLog || webvpn.medias || webvpn.download)) {
      groupLogs(title, arguments)
      if (!interceptLog || !shouldLog) return
    }

    logger.apply(console, arguments)
  }

  const logs = webvpn.logs = {
    all () {
      const allLogs = []
      for (const key in logs) {
        if (typeof logs[key] === 'function') continue 
        for (const sub in logs[key]) {
          allLogs.push(...logs[key][sub])
        }
      }
      return allLogs
    },
    query (keyword) {
      return this.all().filter(log => typeof log === 'string' && log.indexOf(keyword) >= 0)
    }
  }

  const groupLogs = (title, args) => {
    args = Array.from(args)
    title = title.trim().replace('%c', '')
    const category = title.split(' ')[0]
    const type = title.split('拦截')[1].trim()
    logs[category] = logs[category] || {}
    logs[category][type] = logs[category][type] || []

    // 归档为字符串：consumers (logs.query / plugins.js scanLogs) 均按字符串处理
    // 2 参且首参为 '%c' 前缀时，去 '%c' 取首参文本（第二参为 CSS 样式，丢弃）；其余情况拼接为字符串
    let entry
    if (args.length === 2 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
      entry = args[0].slice(2)
    } else {
      entry = args.map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()).join(' ')
    }
    // 限制每个分类的日志条数，超限时批量裁剪，避免每次 push 都 O(n) shift
    const arr = logs[category][type]
    if (arr.length > 600) arr.splice(0, arr.length - 500)
    arr.push(entry)
  }

  Object.assign(webvpn, {
    transformUrl,
    decodeUrl,
    log: logger,
    ajaxUrls,
    fetchUrls,
    domUrls,
    blobs
  })

})()
