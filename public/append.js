(function () {

  if (window.webvpn.transformUrl) return

  const logTypes = ['AJAX', 'fetch', 'History']

  const siteUrl = webvpn.site
  const site = new URL(siteUrl)
  const base = webvpn.base
  const vpnDomain = site.host.replace('www', '')

  const location = window.location

  const defineWebvpnLocation = () => {
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
  }
  defineWebvpnLocation()

  const ajaxUrls = []
  const fetchUrls = []
  const domUrls = []

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
  const locationAttrs = ['hash', 'host', 'hostname', 'href', 'origin', 'pathname', 'port', 'protocol', 'search']

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
    if (u.host.includes(vpnDomain)) {
      if (url.startsWith('http') && webvpn.protocol === 'http:') {
        return url.replace('https://', 'http://')
      }
      return url
    }
    let subdomain = window.base32.encode(u.host)
    const hostPrefix = location.hostname.split('.')[0]
    if (hostPrefix.includes('-')) {
      subdomain += '-' + hostPrefix.split('-').slice(-2).join('-')
    }
    const siteOrigin = site.origin.replace('www', subdomain)
    return url.replace(u.origin, siteOrigin)
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
    let subdomain = u.host.split('.')[0]
    if (subdomain.includes('-')) subdomain = subdomain.split('-')[0]
    const host = window.base32.decode(subdomain)
    url = url.replace(u.origin, window.location.protocol + '//' + host)
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
    }
    if (node.nodeName === 'SCRIPT' && !node.src && !node.textContent.includes('self.__context__')) {
      if (node.textContent[0] === '{' || node.textContent[0] === '[') {
        try {
          JSON.parse(node.textContent)
        } catch {
          node.textContent = `new Function(\`with (self.__context__) { ${node.textContent} }\`).bind(self.__context__)()`
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

  const decodeUrlInHtml = (html) => {
    // TODO 先不管 srcset data codebase 之类的
    const urls = new Set()
    Array.from(html.matchAll(/(href|src|poster|action)="([^"]*)"/g)).forEach(match => {
      if (match[2].includes(vpnDomain)) urls.add(match[2])
    })
    if (urls.size) {
      Array.from(urls).sort((a, b) => b.length - a.length).forEach(url => {
        html = html.replaceAll(url, decodeUrl(url))
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

  // Object.assign 拦截
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

  // Function 拦截
  const _Function = window.Function
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

  // eval 不能拦截，Function 作用于全局，可以拦截，eval 在代码运行作用域起作用，要访问局部变量，eval 方法读不到那些局部变量
  // eval 拦截
  // const _eval = window.eval
  // window.eval = function eval (code) {
  //   const isDefineVars = /^\s*(var|let|const)/.test(code)
  //   code = `new Function(\`with (self.__context__) { ${(isDefineVars ? '' : 'return ') + code} }\`).bind(self.__context__)()`
  //   return _eval(code)
  // }

  // EventSource 拦截
  const _EventSource = window.EventSource
  window.EventSource = new Proxy(_EventSource, {
    construct (target, [url, configuration]) {
      url = transformUrl(url)
      console.log('%cEventSource 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;')
      return new _EventSource(url, configuration)
    }
  })

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
      const init = {}
      for (let key in input) {
        const value = input[key]
        if (key === 'url' || typeof value === 'function') continue
        init[key] = value
      }
      input = new Request(newUrl, init)
    }
    return fetch(input, init)
  }

  // dom 操作拦截

  const getInnerHTML = Element.prototype.getInnerHTML
  Element.prototype.getInnerHTML = function () {
    domLog(this, 'getInnerHTML')
    return this.innerHTML
  }

  // appendChild 拦截
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

  // insertBefore 拦截
  function insertBefore_wrap (func) {
    return function (node, sibling) {
      domLog(node, 'insertBefore')
      node = transformNode(node)
      return func.bind(this)(node, sibling)
    }
  }
  Node.__insertBefore__ = Node.prototype.insertBefore
  Node.prototype.insertBefore = insertBefore_wrap(Node.__insertBefore__)

  // replaceChild 拦截
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

  // insertAdjacentElement 拦截
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

  // document.URL
  Object.defineProperty(document, 'URL', {
    get () {
      return webvpn.url
    }
  })

  // document.domain
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
      return webvpn.url
    }
  })

  Object.defineProperty(HTMLElement.prototype, 'baseURI', {
    get () {
      return webvpn.url
    }
  })

  // TODO TODO 目前发现部分网站自定义了 cookie descriptor，会出现错误
  if (Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')) {
    Object.defineProperty(Document.prototype, 'cookie', { configurable: false })
  }
  if (Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie')) {
    Object.defineProperty(HTMLDocument.prototype, 'cookie', { configurable: false })
  }

  // TODO TODO createTask 有问题？？？
  const _createTask = console.createTask
  delete console.createTask

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
  window.location.__navigate__ = window.location._navigate

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
  window.location.__assign__ = window.location._assign

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
  window.location.__replace__ = window.location._replace

  // location reload
  window.location._reload = function () {
    if (!canJump(location.href)) return false
    return window.location.reload()
  }
  window.location.__reload__ = window.location._reload

  // location toString
  window.location._toString = function () {
    return window.location.__href__
  }
  window.location.__toString__ = window.location._toString

  function redefineGlobals (win) {
    if (!webvpn.target) defineWebvpnLocation()
    // window.__location__
    if (!Object.keys(win.location).length) return
    win.__location__ = {}
    locationAttrs.forEach(key => {
      win.location['__' + key + '__'] = webvpn.target[key]
      for (let i = 0; i < 2; i++) {
        if (i) key = '__' + key + '__'
        Object.defineProperty(win.__location__, key, {
          get () {
            key = key.replaceAll('__', '')
            if (locationAttrs.includes(key)) {
              return new URL(decodeUrl(win.location.href))[key]
            }
            return webvpn.target[key] || location[key]
          },
          set (value) {
            if (key === 'href' || key === '__href__') {
              console.log(
                '%c__location__ 拦截 href : ' + value,
                'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
              )
              if (!canJump(value)) return false
              value = transformUrl(value)
              win.location.href = value
            } else {
              location[key] = value
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
          // 如果 value 是 function，不一定是真的函数，也可能是 Promise 这种，Promise 有 prototype
          if (typeof value === 'function' && !value.prototype) {
            if (property === 'fetch') return window.fetch
            return value.bind(obj)
          }
          return value
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
    return win
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
      if (value && (value.startsWith('http') || value.startsWith('//')) && type !== 'custom' && item[2].includes(attr)) {
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
    if (transformUrl(url).split(/(\?#)/)[0] === location.href.split(/(\?#)/)[0]) return false
    if (disableJump) return false
    if (confirmJump) {
      const ok = confirm('允许跳转到 ' + url + ' 吗？')
      if (!ok) return false
    }
    return true
  }

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
        let url = this.getAttribute('href') || decodeUrl(location.href)
        if (!url.startsWith('http') && !url.startsWith('//')) {
          url = urljoin(webvpn.url, url)
        }
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
    get () {
      const html = ihDescriptor.get.call(this)
      return decodeUrlInHtml(html)
    },
    set (html) {
      html = (html || '').toString()
      // 去除无用的 \n，减少 DOM 渲染，提高执行效率（不会是 pre 元素吧？）
      const childs = html2dom(html, this)
      console.log(
        '%cDOM 操作 拦截 innerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
        'color: #606666;background-color: lightblue;padding: 5px 10px;'
      )
      const container = document.createElement('div')
      for (const child of childs) {
        container.appendChild(child)
      }
      html = container.innerHTML
      html = replaceEscaped(html, 1)
      ihDescriptor.set.apply(this, [html])
    }
  })

  // outerHTML 拦截
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
      return Object.assign({}, cw, { ...cw.__context__ })
    }
  })

  const cdDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    get () {
      return this.contentWindow.__document__
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
          allLogs.push(...logs[key][sub])
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
