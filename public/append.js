(function () {

  if (window.webvpn.transformUrl) return

  const logTypes = ['AJAX', 'fetch', 'History']

  const siteUrl = webvpn.site
  const site = new URL(siteUrl)
  const base = webvpn.base
  const vpnDomain = site.host.replace('www', '')

  const location = window.location

  const ajaxUrls = []
  const fetchUrls = []
  const domUrls = []

  Object.defineProperties(webvpn, {
    location: {
      get () {
        return location
      }
    },
    url: {
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
        return new URL(webvpn.url)
      }
    }
  })

  const SVG_NS = 'http://www.w3.org/2000/svg'

  const interceptLog = webvpn.interceptLog
  const disableJump = webvpn.disableJump
  const confirmJump = webvpn.confirmJump

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
    [HTMLObjectElement, 'object', 'codebase'],
  ]
  const nodeNameAttrsMap = {}
  nodeAttrSetters.forEach((item) => {
    nodeNameAttrsMap[item[1]] = nodeNameAttrsMap[item[1]] || []
    nodeNameAttrsMap[item[1]].push(item[2])
  })

  const ignoredPrefixes = ['mailto:', 'sms:', 'tel:', 'javascript:', 'data:', 'blob:']
  const globalCons = ['window', 'document', 'globalThis', 'parent', 'self', 'top']

  const escaped = {}
  Array.from([
    ['&amp;', '&'], ['&quot;', '"'], ['&lt;', '<'], ['&gt;', '>'], ['&nbsp;', ' '],
    ['&ensp;', ' '], ['&emsp;', ' '], ['&copy;', '©'], ['&iexcl;', '¡'],
    ['&Aacute;', 'Á'], ['&aacute;', 'á'], ['&cent;', '¢'], ['&circ;', 'ˆ'], ['&acirc;', 'â'],
    ['&pound;', '£'], ['&Atilde;', 'Ã'], ['&atilde;', 'ã'], ['&curren;', '¤'], ['&Auml', 'Ä'],
    ['&auml;', 'ä'], ['&yen;', '¥'], ['&ring;', '˚'], ['&aring;', 'å'], ['&brvbar;', '¦'],
    ['&AElig;', 'Æ'], ['&aelig;', 'æ'], ['&sect;', '§'], ['&Ccedil;', 'Ç'], ['&ccedil;', 'ç'],
    ['&uml;', '¨'], ['&Egrave;', 'È'], ['&egrave;', 'è'], ['&copy;', '©'], ['&Eacute;', 'É'],
    ['&eacute;', 'é'], ['&ordf;', 'ª'], ['&Ecirc;', 'Ê'], ['&ecirc;', 'ê'], ['&laquo;', '«'],
    ['&Euml;', 'Ë'], ['&euml;', 'ë'], ['&not;', '¬'], ['&Igrave;', 'Ì'], ['&igrave;', 'ì'],
    ['&shy;', '­'], ['&Iacute;', 'Í'], ['&iacute;', 'í'], ['&reg;', '®'], ['&Icirc;', 'Î'],
    ['&icirc;', 'î'], ['&macr;', '¯'], ['&Iuml;', 'Ï'], ['&iuml;', 'ï'], ['&deg;', '°'],
    ['&ETH;', 'Ð'], ['&plusmn;', '±'], ['&Ntilde;', 'Ñ'], ['&ntilde;', 'ñ'],
    ['&sup2;', '²'], ['&Ograve;', 'Ò'], ['&ograve;', 'ò'], ['&sup3;', '³'], ['&Oacute;', 'Ó'],
    ['&oacute;', 'ó'], ['&acute;', '´'], ['&Ocirc;', 'Ô'], ['&ocirc;', 'ô'], ['&micro;', 'µ'],
    ['&Otilde;', 'Õ'], ['&otilde;', 'õ'], ['&para;', '¶'], ['&Ouml;', 'Ö'], ['&ouml;', 'ö'],
    ['&middot;', '·'], ['&times;', '×'], ['&divide;', '÷'], ['&cedil;', '¸'], ['&Oslash;', 'Ø'],
    ['&oslash;', 'ø'], ['&sup1;', '¹'], ['&Ugrave;', 'Ù'], ['&ugrave;', 'ù'], ['&ordm;', 'º'],
    ['&Uacute;', 'Ú'], ['&uacute;', 'ú'], ['&raquo;', '»'], ['&Ucirc;', 'Û'], ['&ucirc;', 'û'],
    ['&frac14;', '¼'], ['&Uuml;', 'Ü'], ['&uuml;', 'ü'], ['&frac12;', '½'], ['&Yacute;', 'Ý'],
    ['&yacute;', 'ý'], ['&frac34;', '¾'], ['&THORN;', 'Þ'], ['&thorn;', 'þ'], ['&iquest;', '¿'],
    ['&szlig;', 'ß'], ['&yuml;', 'ÿ'], ['&Agrave;', 'À'], ['&agrave;', 'à']
  ]).forEach(ele => escaped[ele[0]] = ele[1])

  const transformUrl = (url) => {
    url = (url ? url.toString() : '').trim()
    for (let prefix of ignoredPrefixes) {
      if (url.indexOf(prefix) >= 0) {
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
    const u = new URL(url)
    if (u.hostname.includes(vpnDomain)) {
      if (url.startsWith('http') && webvpn.protocol === 'http:') {
        return url.replace('https://', 'http://')
      }
      return url
    }
    const subdomain = window.base32.encode(u.host)
    return url.replace(u.origin, site.origin.replace('www', subdomain))
  }

  const decodeUrl = (url) => {
    url = (url || '').trim()
    if (!url) return url
    if (url.split('?')[0].indexOf('http') < 0) {
      return urljoin(location.href, url)
    }
    if (url.indexOf('http://') > 0 || url.indexOf('https://') > 0) {
      url = url.slice(url.indexOf('http'))
    }
    const u = new URL(url)
    const host = window.base32.decode(u.host.split('.')[0])
    return url.replace(u.origin, window.location.protocol + '//' + host)
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
    return node
  }

  const transformHtml = (html, root) => {
    const json = html2json(html)
    const childs = json2dom(json, root)
    const doc = document.createDocumentFragment()
    for (const child of childs) {
      doc.appendChild(child)
    }
    html = Array.from(doc.childNodes).map(child => child.outerHTML).join('')
    html = html.replaceAll('&amp;amp;', '&amp;')
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
    if (root.nodeType !== 1) return 
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
      let parts = url.split(/(\\n|,|\s+)/g)
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
      if (url.indexOf(prefix) >= 0) return false
    }
    return url.indexOf(vpnDomain) < 0
  }

  const urljoin = (url, path) => {
    const { origin, pathname } = new URL(url)
    if (path[0] === '/') return origin + path
    if (url.endsWith('/')) return url + path
    return url.split('/').slice(0, -1).join('/') + '/' + path
  }

  // ajax 拦截
  const xhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, async = true, user, password) {
    const newUrl = transformUrl(url)
    console.log('%cAJAX 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
    ajaxUrls.push(url)
    return xhrOpen.bind(this)(method, newUrl, async, user, password)
  }

  // fetch 拦截
  const fetch = window.fetch
  window.fetch = function (input, init) {
    const isInputUrl = typeof input === 'string'
    const url = isInputUrl ? input : input.url
    const newUrl = transformUrl(url)
    console.log('%cfetch 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
    fetchUrls.push(url)
    if (isInputUrl) {
      input = newUrl
    } else {
      input.url = newUrl
    }
    return fetch(input, init)
  }

  // dom 操作拦截

  // appendChild 拦截
  const appendChild = Node.prototype.appendChild
  Node.prototype.appendChild = function (node) {
    if (!(node instanceof Node)) return
    if (node._type_ !== 'custom') {
      domLog(node, 'appendChild')
      node = transformNode(node)
    }
    return appendChild.call(this, node)
  }

  // insertBefore 拦截
  const insertBefore = Node.prototype.insertBefore
  Node.prototype.insertBefore = function (node, sibling) {
    domLog(node, 'insertBefore')
    node = transformNode(node)
    return insertBefore.bind(this)(node, sibling)
  }

  // replaceChild 拦截
  const replaceChild = Node.prototype.replaceChild
  Node.prototype.replaceChild = function (node, oldNode) {
    domLog(node, 'replaceChild')
    node = transformNode(node)
    return replaceChild.bind(this)(node, oldNode)
  }

  Array.from(['replaceChildren', 'prepend', 'append', 'before', 'after']).forEach((name) => {
    const origin = Element.prototype[name]
    Element.prototype[name] = function () {
      const nodes = arguments
      transformArgumentsNodes(nodes, name)
      return origin.apply(this, nodes)
    }
  })

  // setAttribute 拦截
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

  // insertAdjacentHTML 拦截
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML
  Element.prototype.insertAdjacentHTML = function (position, html) {
    console.log(
      '%cDOM 操作 拦截 insertAdjacentHTML : ' + html,
      'color: #606666;background-color: lime;padding: 5px 10px;'
    )
    html = transformHtml(html, this)
    return insertAdjacentHTML.bind(this)(position, html)
  }

  // a 元素 click 拦截
  const aOnClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    console.log(
      '%cDOM History 操作 拦截 a click : ' + this.href,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(this.href)) return false
    return aOnClick.apply(this, arguments)
  }

  // document.domain
  Object.defineProperty(document, 'domain', {
    get () {
      return webvpn.target.hostname
    },
    set (value) {
      console.log('%cset document.domain: ' + value, 'background-color: red; color: white; padding: 5px 10px;')
    }
  })

  // document.referrer
  const _referrer = decodeUrl(document.referrer.includes(webvpn.site) ? (location.origin + '/') : document.referrer)
  Object.defineProperty(document, 'referrer', {
    get () {
      return _referrer
    }
  })

  // open 拦截
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

  // go 拦截
  const go = History.prototype.go
  History.prototype.go = function (value) {
    if ((value + '') !== (parseInt(value) + '')) {
      console.log(
        '%cHistory 操作 拦截 go : ' + value,
        'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
      )
      value = transformUrl(value)
    }
    if (!canJump(value)) return false
    return go.apply(this, [value])
  }

  // _navigate 拦截
  window.location._navigate = function (url) {
    console.log(
      '%c_navigate 拦截 : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.navigate(url)
  }

  // location _assign 拦截
  window.location._assign = function (url) {
    console.log(
      '%clocation 操作 拦截 _assign : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.location.assign(url)
  }

  // location _replace 拦截
  window.location._replace = function (url) {
    console.log(
      '%clocation 操作 拦截 _replace : ' + url,
      'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
    )
    if (!canJump(url)) return false
    url = transformUrl(url)
    return window.location.replace(url)
  }

  function copySource (source) {
    const copied = Object.assign({}, source)
    for (const key in source) {
      const value = source[key]
      copied[key] = typeof value === 'function' ? value.bind(source) : value
    }
    return copied
  }

  function redefineGlobals (win) {
    // window.__location__
    Array.from(['host', 'hostname', 'origin', 'href', 'protocol']).forEach(key => {
      win.location['__' + key + '__'] = webvpn.target[key]
    })
    win.__location__ = Object.assign({}, copySource(location), copySource(webvpn.target))
    win.__location__.assign = win.location._assign
    win.__location__.replace = win.location._replace

    // __location__.href 拦截
    for (let key of ['href', '__href__']) {
      Object.defineProperty(win.__location__, key, {
        get () {
          return decodeUrl(win.location.href)
        },
        set (url) {
          console.log(
            '%c__location__ 拦截 href : ' + url,
            'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
          )
          if (!canJump(url)) return false
          url = transformUrl(url)
          win.location.href = url
        }
      })
    }

    for (const con of globalCons) {
      win['__' + con + '__'] = new Proxy(win[con], {
        get (obj, property, receiver) {
          const w = (obj === parent || obj === top) ? obj : win
          if (globalCons.includes(property) || property === 'location') {
            return w['__' + property + '__']
          }
          const value = obj[property]
          // 如果 value 是 function，不一定是真的函数，也可能是 Promise 这种，Promise 有 prototype
          return (typeof value === 'function' && !value.prototype) ? value.bind(obj) : value
        },
        set (obj, property, value) {
          if (property === 'window') return false
          if (property === 'location') {
            if (obj === parent || obj === top) {
              obj.__location__.href = value
              return true
            }
            console.log(
              '%clocation 操作 拦截 location = : ' + value,
              'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
            )
            if (!canJump(value)) return true
            value = transformUrl(value)
            win.location.href = value
          }
          obj[property] = value
          return true
        }
      })
    }
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
        win[prop] = value
        return value
      }
    })
  }

  redefineGlobals(window)

  for (let key in window) {
    if (typeof window[key] === 'function') {
      window[key] = window[key].bind(window)
    }
  }

  setInterval(() => {
    const location = window.__context__.location
    if (typeof location === 'string') {
      window.location.href = transformUrl(location)
    }
  }, 500)

  // 因为用 __document__ 替换了 document, __document__ 的时候类型跟 document 不一致
  const observe = MutationObserver.prototype.observe
  MutationObserver.prototype.observe = function (obj, options) {
    if (obj == window.__document__) obj = document
    return observe.bind(this)(obj, options)
  }

  // getAttribute 拦截
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
      if (value && type !== 'custom' && item[2].includes(attr)) {
        console.log(
          '%cDOM 操作 拦截 getAttribute : ' + item[1] + ' - ' + item[2] + ' ' + value,
          'color: #606666;background-color: lime;padding: 5px 10px;'
        )
        value = decodeUrl(value)
      }
      return value
    }
  })

  // Worker 创建拦截
  const _Worker = window.Worker
  window.Worker = function (url, options) {
    console.log(
      '%cnew 拦截 Worker : ' + url,
      'color: #606666;background-color: lime;padding: 5px 10px;'
    )
    url = transformUrl(url)
    return new _Worker(url, options)
  }

  // ServiceWorkerContainer register 拦截
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

  // pushState replaceState 拦截
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
    if (disableJump) return false
    if (confirmJump) {
      const ok = confirm('允许跳转到 ' + url + ' 吗？')
      if (!ok) return false
    }
    return true
  }

  Object.defineProperty(HTMLElement.prototype, 'baseURI', {
    get () {
      return webvpn.url
    }
  })

  nodeAttrSetters.forEach((item) => {
    let descriptor = Object.getOwnPropertyDescriptor(item[0].prototype, item[2])
    // audio video 的 src 描述符没了，转到了 media 的描述符上
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
        if (!value || value.startsWith('blob:')) return value
        return decodeUrl(value)
      },
      set (url) {
        srcLog(item[1], item[2], url)
        descriptor.set.call(this, transformUrl(url))
      }
    })
  })

  // a 元素的 host 等 URL 属性 拦截, href 在上面的 get 函数里拦截了
  const aUrlAttrs = ['href', 'host', 'hostname', 'origin', 'port', 'protocol']
  aUrlAttrs.forEach((attr) => {
    Object.defineProperty(HTMLAnchorElement.prototype, attr, {
      get () {
        console.log(
          '%cDOM 操作 拦截 a ' + attr + ' getter',
          'color: #606666;background-color: lime;padding: 5px 10px;'
        )
        const url = this.getAttribute('href') || decodeUrl(location.href)
        if (attr === 'href') return url
        return new URL(url)[attr]
      }
    })
  })

  // style.backgroundImage 拦截
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
            value = value.replace(/url\(([^\)]+)\)/g, text => {
              const url = text.replace(/(url\(|\)|\'|\")/g, '')
              return text.replace(url, transformUrl(url))
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

  // 附注：这里只是拦截 CSS 操作，不知道所属哪个节点，如果想知道，可以放在上面，通过 style.cssText 拦截
  const ctDescriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')
  Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
    set (value) {
      let hasUrl = false
      value = value.replace(/url\(([^\)]+)\)/g, text => {
        hasUrl = true
        const url = text.replace(/(url\(|\)|\'|\")/g, '')
        return text.replace(url, transformUrl(url))
      })
      hasUrl && console.log(
        '%cstyle 操作 拦截 cssText : ' + value,
        'color: #606666;background-color: lime;padding: 5px 10px;'
      )
      ctDescriptor.set.apply(this, [value])
    }
  })

  // document.write 拦截
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

  // document.writeln 拦截
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

  // 注意，已经没有真正的 innerHTML 方法了，原生的 innerHTML 不存在了
  // 现在的仅是通过创建节点，设置节点子节点、文本内容，没有设置 html 内容的功能

  // innerHTML 拦截
  const ihDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
  Object.defineProperty(Element.prototype, '__innerHTML__', {
    set: ihDescriptor.set
  })
  Object.defineProperty(Element.prototype, 'innerHTML', {
    set (html) {
      html = (html || '').toString()
      // 去除无用的 \n，减少 DOM 渲染，提高执行效率（不会是 pre 元素吧？）
      const json = html2json(html)
      const childs = json2dom(json, this)
      console.log(
        '%cDOM 操作 拦截 innerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
        'color: #606666;background-color: lightblue;padding: 5px 10px;'
      )
      const container = document.createElement('div')
      for (const child of childs) {
        container.appendChild(child)
      }
      html = container.innerHTML
      ihDescriptor.set.apply(this, [html])
    }
  })

  // outerHTML 拦截
  const ohDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')
  Object.defineProperty(Element.prototype, '__outerHTML__', {
    set: ohDescriptor.set
  })
  Object.defineProperty(Element.prototype, 'outerHTML', {
    set (html) {
      html = (html || '').toString()
      const json = html2json(html)
      const childs = json2dom(json, this)
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
      redefineGlobals(cw)
      return Object.assign({}, cw, { ...cw.__context__ })
    }
  })

  const cdDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    get () {
      return this.contentWindow.__document__
    }
  })

  const json2dom = (json, root) => {
    const isSvg = root && root instanceof SVGElement || json.tag === 'svg'
    let node

    if (json.node === 'element' || json.node === 'root') {
      if (isSvg) {
        node = document.createElementNS(SVG_NS, json.tag)
      } else {
        node = document.createElement(json.tag || 'div')
      }
      const attr = json.attr || {}
      for (const key in attr) {
        if (Array.isArray(attr[key])) {
          attr[key] = attr[key].join(' ')
        }
        if (hasEscaped(attr[key], 2)) {
          attr[key] = replaceEscaped(attr[key], 2)
        }
        if (linkTags.includes(json.tag) && urlAttrs.includes(key)) {
          attr[key] = transformUrl(attr[key])
        }
        node.setAttribute(key, attr[key], 'custom')
      }
    } else if (json.node === 'text') {
      for (let i = 1; i < 4; i++) {
        if (hasEscaped(json.text, i)) {
          json.text = replaceEscaped(json.text, i)
        }
      }
      node = document.createTextNode(json.text)
    }

    if (json.child) {
      for (const ele of json.child) {
        if (ele.node === 'comment') continue
        const dom = json2dom(ele, node)
        dom._type_ = 'custom'
        node.appendChild(dom)
      }
    }

    if (json.node !== 'root') return node
    return Array.from(node.childNodes)
  }

  const hasEscaped = (text, index) => {
    if (index === 1) return /&\w+/.test(text)
    if (index === 2) return /&#\d+;/.test(text)
    if (index === 3) return /&#x\w+;/.test(text)
  }

  const replaceEscaped = (text, index) => {
    if (index === 1) {
      for (const key in escaped) {
        if (text.indexOf(key) >= 0) {
          text = text.replaceAll(key, escaped[key])
        }
        const prefix = key.slice(0, -1)
        if (text.indexOf(prefix) >= 0) {
          text = text.replaceAll(prefix, escaped[key])
        }
      }
      return text
    }
    if (index === 2) {
      return text.replaceAll(/&#\d+;/g, (part) => String.fromCharCode(part.slice(2, -1) * 1))
    }
    if (index === 3) {
      return text.replaceAll(/&#x\w+;/g, (part) => String.fromCharCode(parseInt(part.slice(3, -1), 16)))
    }
  }

  const removeChilds = (node) => {
    const childs = Array.from(node.childNodes || [])
    childs.forEach(child => child.remove())
  }

  const getNodeName = (node) => {
    return (node.nodeName || node.tagName || '').toLowerCase()
  }

  const getAttacher = (node) => {
    return getNodeName(node) === 'template' ? node.content : node
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

  window.addEventListener('load', replaceNodesUrls)
  setTimeout(replaceNodesUrls, 1000)
  setTimeout(replaceNodesUrls, 2000)
  setInterval(replaceNodesUrls, 3000)

  // 事件绑定的 this 对象拦截替换
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

  const logger = console.log
  console.log = function () {
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
    if (title) {
      groupLogs(title, arguments)
      if (!interceptLog || !shouldLog) return 
    }

    logger.apply(console, arguments)
  }

  const logs = webvpn.logs = {
    all  () {
      const allLogs = []
      for (const key in logs) {
        if (typeof logs[key] === 'function') continue 
        for (const sub in logs[key]) {
          allLogs = allLogs.concat(logs[key][sub])
        }
      }
      return allLogs
    },
    query (keyword) {
      const allLogs = this.all()
      return allLogs.filter(log => typeof log === 'string' && log.indexOf(keyword) >= 0)
    }
  }

  const groupLogs = (title, args) => {
    args = Array.from(args)
    title = title.trim().replace('%c', '')
    const category = title.split(' ')[0]
    const type = title.split('拦截')[1].trim()
    logs[category] = logs[category] || {}
    logs[category][type] = logs[category][type] || []

    if (args.length === 2 && args[0].startsWith('%c')) {
      args = args[0].slice(2)
    }
    logs[category][type].push(args)
  }

  Object.assign(webvpn, {
    transformUrl,
    decodeUrl,
    log: logger,
    ajaxUrls,
    fetchUrls,
    domUrls
  })

})()
