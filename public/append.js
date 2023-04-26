(function () {

	if (window.location.__href__) {
		return
	}

	var logTypes = ['AJAX', 'fetch', 'History'];

	var siteUrl = webvpn.site;
	var site = new URL(siteUrl);
	var base = webvpn.base;
	var vpnDomain = site.host.replace('www', '');

	var location = window.location;

	Object.defineProperties(webvpn, {
		location: {
			get () {
				return location;
			}
		},
		url: {
			get () {
				var url = decodeUrl(location.href);
				if (!url.startsWith(webvpn.protocol)) {
					url = url.replace(webvpn.protocol === 'https:' ? 'http:' : 'https:', webvpn.protocol);
				}
				return url;
			}
		},
		target: {
			get () {
				return new URL(webvpn.url);
			}
		}
	});

	var SVG_NS = 'http://www.w3.org/2000/svg';

	var interceptLog = webvpn.interceptLog;
	var disableJump = webvpn.disableJump;
	var confirmJump = webvpn.confirmJump;

	var linkTags = ['a', 'img', 'script', 'link', 'video', 'audio', 'source', 'iframe', 'form', 'embed', 'object'];
	var urlAttrs = ['href', 'src', 'srcset', 'poster', 'action', 'data', 'codebase'];
	var nodeAttrSetters = [
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
	];
	var nodeNameAttrsMap = {};
	nodeAttrSetters.forEach(function (item) {
		nodeNameAttrsMap[item[1]] = nodeNameAttrsMap[item[1]] || [];
		nodeNameAttrsMap[item[1]].push(item[2]);
	});

	window.ajaxUrls = [];
	window.fetchUrls = [];
	window.domUrls = [];

	Object.assign(webvpn, {
		transformUrl,
		decodeUrl
	});

	var ignoredPrefixes = ['mailto:', 'sms:', 'tel:', 'javascript:', 'data:', 'blob:'];

	var escaped = {};
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
	]).forEach(function (ele) {
		escaped[ele[0]] = ele[1];
	});

	function transformUrl (url) {
		url = (url ? url.toString() : '').trim();
		for (var prefix of ignoredPrefixes) {
			if (url.indexOf(prefix) >= 0) {
				return url;
			}
		}
		if (!url || url.split('?')[0].indexOf('//') < 0) {
			return url;
		}
		if (url.indexOf('http') < 0 && url.indexOf('//') > 0) {
			url = url.slice(url.indexOf('//'));
		}
		if (url.startsWith('//')) {
			url = webvpn.protocol + url;
		}
		if (url.indexOf('http://') > 0 || url.indexOf('https://') > 0) {
			url = url.slice(url.indexOf('http'));
		}
		if (url.indexOf(vpnDomain) > 0) {
			if (url.startsWith('http')) {
				return url.replace('https://', 'http://')
			}
			return url;
		}
		var u = new URL(url);
		var subdomain = window.base32.encode(u.host);
		return url.replace(u.origin, site.origin.replace('www', subdomain));
	}

	function decodeUrl (url) {
		url = (url || '').trim();
		if (!url) {
			return url;
		}
		if (url.split('?')[0].indexOf('http') < 0) {
			return urljoin(location.href, url);
		}
		if (url.indexOf('http://') > 0 || url.indexOf('https://') > 0) {
			url = url.slice(url.indexOf('http'));
		}
		var u = new URL(url);
		var host = window.base32.decode(u.host.split('.')[0]);
		return url.replace(u.origin, window.location.protocol + '//' + host);
	}

	function transformArgumentsNodes (nodes, funcName) {
		for (var i = 0, len = nodes.length; i < len; i++) {
			var node = nodes[i];
			domLog(node, funcName);
			nodes[i] = transformNode(node);
		}
	}

	function transformNode (node) {
		var tag = getNodeName(node);
		if (linkTags.includes(tag)) {
			var link = getNodeUrl(node);
			var url = link[0];
			var urlAttr = link[1];
			var newUrl = transformUrl(url);
			node[urlAttr] = newUrl;
		}
		replaceNodesUrls(node);
		return node;
	}

	function transformHtml (html, root) {
		var json = html2json(html);
		var childs = json2dom(json, root);
		var doc = document.createDocumentFragment();
		for (var child of childs) {
			doc.appendChild(child);
		}
		html = Array.from(doc.childNodes).map(function (child) {
			return child.outerHTML;
		}).join('');
		return html;
	}

	function getNodeUrl (node) {
		if (!node.getAttribute) {
			return ['', ''];
		}
		var url = '';
		var urlAttr = '';
		for (var attr of urlAttrs) {
			url = (node.getAttribute(attr, 'custom') || '').trim();
			urlAttr = attr;
			if (url) {
				break;
			}
		}
		return [url, urlAttr];
	}

	function replaceNodesUrls (root) {
		var type = root ? undefined : 'custom';
		root = root || document.documentElement;
		if (root.nodeType !== 1) {
			return ;
		}
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
		var all = [];
		var n = null;
		while (n = walker.nextNode()) {
			var name = getNodeName(n);
			if (linkTags.includes(name)) {
				n.node_name = name;
				all.push(n);
			}
		}
		all.forEach(function (node) {
			var attrs = nodeNameAttrsMap[node.node_name];
			if (!attrs) {
				replaceNodeUrl(root, node, null, type);
				return ;
			}
			attrs.forEach(function (attr) {
				replaceNodeUrl(root, node, attr, type);
			});
		});
	}

	function replaceNodeUrl (root, node, attr, type) {
		var url = '';
		var urlAttr = '';
		if (attr) {
			url = node.getAttribute(attr, 'custom');
			urlAttr = attr;
		} else {
			var link = getNodeUrl(node);
			url = link[0];
			urlAttr = link[1];
		}
		if (!checkUrlShouldReplace(url, attr)) {
			return ;
		}
		var newUrl = transformUrl(url);
		if (attr === 'srcset') {
			var parts = url.split(/(\\n|,|\s+)/g);
			var symbols = [' ', ',', ''];
			parts = parts.map(function (part) {
				if (symbols.includes(part) || /^\dx$/.test(part)) {
					return part;
				}
				return transformUrl(part);
			});
			newUrl = parts.join('');
		}
		if (newUrl !== url) {
			var tag = node.node_name;
			if (root || tag !== 'script') {
				node.setAttribute(urlAttr, newUrl, type);
			} else {
				var copy = node.cloneNode(true);
				copy.src = newUrl;
				node.parentNode.appendChild(copy);
				node.remove();
			}
		}
	}

	function checkUrlShouldReplace (url, attr) {
		url = (url || '').trim();
		if (!url) {
			return false;
		}
		if (attr === 'srcset') {
			return !!url;
		}
		for (var prefix of ignoredPrefixes) {
			if (url.indexOf(prefix) >= 0) {
				return false;
			}
		}
		return url.indexOf(vpnDomain) < 0;
	}

	function urljoin (url, path) {
		var { origin, pathname } = new URL(url);
		if (path[0] === '/') {
			return origin + path;
		}
		if (url.endsWith('/')) {
			return url + path;
		}
		return url.split('/').slice(0, -1).join('/') + '/' + path;
	}

	// ajax 拦截
	var xhrOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, async = true, user, password) {
		var newUrl = transformUrl(url);
		console.log('%cAJAX 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;');
		window.ajaxUrls.push(url);
		return xhrOpen.bind(this)(method, newUrl, async, user, password);
	}

	// fetch 拦截
	var fetch = window.fetch;
	window.fetch = function (input, init) {
		var isInputUrl = typeof input === 'string';
		var url = isInputUrl ? input : input.url;
		var newUrl = transformUrl(url);
		console.log('%cfetch 请求 拦截 : ' + url, 'color: white;background-color: orange;padding: 5px 10px;');
		window.fetchUrls.push(url);
		if (isInputUrl) {
			input = newUrl;
		} else {
			input.url = newUrl;
		}
		return fetch(input, init);
	}

	// dom 操作拦截

	// appendChild 拦截
	var appendChild = Node.prototype.appendChild;
	Node.prototype.appendChild = function (node) {
		if (!(node instanceof Node)) {
			return
		}
		if (node._type_ !== 'custom') {
			domLog(node, 'appendChild');
			node = transformNode(node);
		}
		return appendChild.call(this, node);
	}

	// insertBefore 拦截
	var insertBefore = Node.prototype.insertBefore;
	Node.prototype.insertBefore = function (node, sibling) {
		domLog(node, 'insertBefore');
		node = transformNode(node);
		return insertBefore.bind(this)(node, sibling);
	}

	// replaceChild 拦截
	var replaceChild = Node.prototype.replaceChild;
	Node.prototype.replaceChild = function (node, oldNode) {
		domLog(node, 'replaceChild');
		node = transformNode(node);
		return replaceChild.bind(this)(node, oldNode);
	}

	Array.from(['replaceChildren', 'prepend', 'append', 'before', 'after']).forEach(function (name) {
		var origin = Element.prototype[name];
		Element.prototype[name] = function () {
			var nodes = arguments;
			transformArgumentsNodes(nodes, name);
			return origin.apply(this, nodes);
		}
	});

	// setAttribute 拦截
	var setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (attr, value, type) {
		if (type !== 'custom' && urlAttrs.includes(attr)) {
			console.log(
				'%cDOM 操作 拦截 setAttribute : ' + this.nodeName.toLowerCase() + ' - ' + attr + ' - ' + value,
				'color: #606666;background-color: lime;padding: 5px 10px;'
			);
			value = transformUrl(value);
		}
		return setAttribute.bind(this)(attr, value);
	}

	// insertAdjacentHTML 拦截
	var insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
	Element.prototype.insertAdjacentHTML = function (position, html) {
		console.log(
			'%cDOM 操作 拦截 insertAdjacentHTML : ' + html,
			'color: #606666;background-color: lime;padding: 5px 10px;'
		);
		html = transformHtml(html, this);
		return insertAdjacentHTML.bind(this)(position, html);
	}

	// a 元素 click 拦截
	var aOnClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		console.log(
			'%cDOM History 操作 拦截 a click : ' + this.href,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(this.href)) return false;
		return aOnClick.apply(this, arguments);
	}

	// open 拦截
	var open = window.open;
	window.open = function (url, name, specs, replace) {
		console.log(
			'%copen 拦截 : ' + url,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(url)) return false;
		url = transformUrl(url);
		return open.bind(window)(url, name, specs, replace);
	}

	// go 拦截
	var go = History.prototype.go;
	History.prototype.go = function (value) {
		if ((value + '') !== (parseInt(value) + '')) {
			console.log(
				'%cHistory 操作 拦截 go : ' + value,
				'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
			);
			value = transformUrl(value);
		}
		if (!canJump(value)) return false;
		return go.apply(this, [value]);
	}

	// _navigate 拦截
	window.location._navigate = function (url) {
		console.log(
			'%c_navigate 拦截 : ' + url,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(url)) return false;
		url = transformUrl(url);
		return window.navigate(url);
	}

	// location _assign 拦截
	window.location._assign = function (url) {
		console.log(
			'%clocation 操作 拦截 _assign : ' + url,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(url)) return false;
		url = transformUrl(url);
		return window.location.assign(url);
	}

	// location _replace 拦截
	window.location._replace = function (url) {
		console.log(
			'%clocation 操作 拦截 _replace : ' + url,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(url)) return false;
		url = transformUrl(url);
		return window.location.replace(url);
	}

	function copySource (source) {
		var copied = Object.assign({}, source);
		for (var key in source) {
			var value = source[key];
			copied[key] = typeof value === 'function' ? value.bind(source) : value;
		}
		return copied;
	}

	// window.__location__
	window.__location__ = Object.assign({}, copySource(location), copySource(webvpn.target));
	window.__location__.assign = window.location._assign;
	window.__location__.replace = window.location._replace;

	// location.__href__, __location__.__href__ 拦截
	for (var key of ['location', '__location__']) {
		Object.defineProperty(window[key], '__href__', {
			get () {
				return webvpn.target.href;
			},
			set (url) {
				console.log(
					'%c' + key + ' 拦截 __href__ : ' + url,
					'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
				);
				if (!canJump(url)) return false;
				url = transformUrl(url);
				window.location.href = url;
			}
		});
	}
	// __location__.href 拦截
	Object.defineProperty(window.__location__, 'href', {
		get () {
			return webvpn.target.href;
		},
		set (url) {
			console.log(
				'%c__location__ 拦截 href : ' + url,
				'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
			);
			if (!canJump(url)) return false;
			url = transformUrl(url);
			window.location.href = url;
		}
	});

	// document.domain
	Object.defineProperty(document, 'domain', {
		get () {
			return webvpn.target.hostname;
		},
		set (value) { }
	});

	// document.referrer
	var _referrer = decodeUrl(document.referrer);
	Object.defineProperty(document, 'referrer', {
		get () {
			return _referrer;
		}
	});

	// __window__, __document__, _globalThis, __parent__, __self__, __top__
	for (var con of ['window', 'document', 'globalThis', 'parent', 'self', 'top']) {
		window['__' + con + '__'] = new Proxy(window[con], {
			get (obj, property, receiver) {
				var win = (obj === parent || obj === top) ? obj : window;
				if (property === 'window') {
					return win.__window__;
				}
				if (property === 'location') {
					return win.__location__;
				}
				var value = obj[property];
				// 如果 value 是 function，不一定是真的函数，也可能是 Promise 这种，Promise 有 prototype
				return (typeof value === 'function' && !value.prototype) ? value.bind(obj) : value;
			},
			set (obj, property, value) {
				if (property === 'window') {
					return false;
				}
				if (property === 'location') {
					if (obj === parent || obj === top) {
						obj.__location__.href = value;
						return true;
					}
					console.log(
						'%clocation 操作 拦截 location = : ' + value,
						'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
					);
					if (!canJump(value)) return true;
					value = transformUrl(value);
					window.location.href = value;
				}
				obj[property] = value;
				return true;
			}
		});
	}

	window.__context__ = {
		self: __self__,
		window: __window__,
		document: __document__,
		globalThis: __globalThis__,
		parent: __parent__,
		top: __top__,
		location: __location__
	};

	setInterval(function () {
		var location = window.__context__.location;
		if (typeof location === 'string') {
			window.location.href = transformUrl(location);
		}
	}, 500);

	// 因为用 __document__ 替换了 document, __document__ 的时候类型跟 document 不一致
	var observe = MutationObserver.prototype.observe;
	MutationObserver.prototype.observe = function (obj, options) {
		if (obj == window.__document__) {
			obj = document;
		}
		return observe.bind(this)(obj, options);
	}

	// getAttribute 拦截
	var nasUnion = [];
	for (var item of nodeAttrSetters) {
		var ele = nasUnion.find(function (ele) {
			return ele[0] === item[0];
		});
		if (!ele) {
			nasUnion.push([item[0], item[1], [item[2]]]);
		} else {
			ele[2].push(item[2]);
		}
	}
	nasUnion.forEach(function (item) {
		var getAttribute = item[0].prototype.getAttribute;
		item[0].prototype.getAttribute = function (attr, type) {
			var value = getAttribute.bind(this)(attr);
			if (value && type !== 'custom' && item[2].includes(attr)) {
				console.log(
					'%cDOM 操作 拦截 getAttribute : ' + item[1] + ' - ' + item[2] + ' ' + value,
					'color: #606666;background-color: lime;padding: 5px 10px;'
				);
				value = decodeUrl(value);
			}
			return value;
		}
	});

	// Worker 创建拦截
	var _Worker = window.Worker;
	window.Worker = function (url, options) {
		console.log(
			'%cnew 拦截 Worker : ' + url,
			'color: #606666;background-color: lime;padding: 5px 10px;'
		);
		url = transformUrl(url);
		return new _Worker(url, options);
	}

	// ServiceWorkerContainer register 拦截
	if (window.ServiceWorkerContainer) {
		var register = window.ServiceWorkerContainer.prototype.register;
		window.ServiceWorkerContainer.prototype.register = function (url, options) {
			console.log(
				'%cServiceWorkerContainer 操作 拦截 register : ' + url,
				'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
			);
			url = transformUrl(url);
			return register.call(this, url, options);
		}
	}

	// pushState replaceState 拦截
	Array.from(['pushState', 'replaceState']).forEach(function (name) {
		var origin = History.prototype[name];
		History.prototype[name] = function (state, title, url) {
			console.log(
				'%cHistory 操作 拦截 ' + name + ' : ' + url,
				'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
			);
			if (!canJump(url)) return false;
			url = transformUrl(url);
			origin.bind(this)(state, title, url);
		}
	});

	function canJump (url) {
		if (disableJump) {
			return false;
		}
		if (confirmJump) {
			var ok = confirm('允许跳转到 ' + url + ' 吗？');
			if (!ok) {
				return false;
			}
		}
		return true;
	}

	Object.defineProperty(HTMLElement.prototype, 'baseURI', {
		get () {
			return webvpn.url;
		}
	});

	nodeAttrSetters.forEach(function (item) {
		Object.defineProperty(item[0].prototype, item[2], {
			get () {
				var value = this.getAttribute(item[2], 'custom');
				console.log(
					'%cDOM 操作 拦截 ' + item[1] + ' ' + item[2] + ' getter : ' + value,
					'color: #606666;background-color: lime;padding: 5px 10px;'
				);
				if (!value || value.startsWith('blob:')) {
					return value;
				}
				return decodeUrl(value);
			},
			set (url) {
				srcLog(item[1], item[2], url);
				this.setAttribute(item[2], transformUrl(url), 'custom');
			}
		});
	});

	// a 元素的 host 等 URL 属性 拦截, href 在上面的 get 函数里拦截了
	var aUrlAttrs = ['href', 'host', 'hostname', 'origin', 'port', 'protocol'];
	aUrlAttrs.forEach(function (attr) {
		Object.defineProperty(HTMLAnchorElement.prototype, attr, {
			get () {
				console.log(
					'%cDOM 操作 拦截 a ' + attr + ' getter',
					'color: #606666;background-color: lime;padding: 5px 10px;'
				);
				var url = this.getAttribute('href');
				if (!url || attr === 'href') {
					return url;
				}
				return new URL(url)[attr];
			}
		});
	});

	// style.backgroundImage 拦截
	// 因为底层用了 background 属性进行赋值，所以现在拦截不了 background 了
	Object.defineProperty(CSSStyleDeclaration.prototype, 'backgroundImage', {
		set (value) {
			var url = value.replace(/(url\(|\)|\'|\")/g, '');
			console.log(
				'%cstyle 操作 拦截 backgroundImage : ' + url,
				'color: #606666;background-color: lime;padding: 5px 10px;'
			);
			url = transformUrl(url);
			this.background = 'url("' + url + '")';
		}
	});

	// document.write 拦截
	var write = document.write;
	document.write = function () {
		var htmls = [];
		for (var html of arguments) {
			htmls.push(transformHtml(html, document.body));
		}
		console.log(
			'%cDOM 操作 拦截 document.write : ' + htmls,
			'color: #606666;background-color: lightblue;padding: 5px 10px;'
		);
		return write.apply(document, htmls);
	}

	// document.writeln 拦截
	var writeln = document.writeln;
	document.writeln = function () {
		var htmls = [];
		for (var html of arguments) {
			htmls.push(transformHtml(html, document.body));
		}
		console.log(
			'%cDOM 操作 拦截 document.writeln : ' + htmls,
			'color: #606666;background-color: lightblue;padding: 5px 10px;'
		);
		return writeln.apply(document, htmls);
	}

	// 注意，已经没有真正的 innerHTML 方法了，原生的 innerHTML 不存在了
	// 现在的仅是通过创建节点，设置节点子节点、文本内容，没有设置 html 内容的功能

	// innerHTML 拦截
	Object.defineProperty(Element.prototype, 'innerHTML', {
		set (html) {
			html = (html || '').toString();
			var node = this;
			var oldHtml = node.innerHTML;
			var appendHtml = '';
			if (oldHtml && oldHtml.length > 0 && html.startsWith(oldHtml)) {
				appendHtml = html.slice(oldHtml.length);
			}
			if (appendHtml.length > 0) {
				html = appendHtml;
			} else {
				removeChilds(node);
			}
			// 去除无用的 \n，减少 DOM 渲染，提高执行效率（不会是 pre 元素吧？）
			html = html.replaceAll('\n', '');
			var json = html2json(html);
			var childs = json2dom(json, this);
			console.log(
				'%cDOM 操作 拦截 innerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
				'color: #606666;background-color: lightblue;padding: 5px 10px;'
			);
			var attacher = getAttacher(node);
			for (var child of childs) {
				attacher.appendChild(child);
			}
		}
	});

	// outerHTML 拦截
	Object.defineProperty(Element.prototype, 'outerHTML', {
		set (html) {
			html = (html || '').toString();
			var node = this;
			var parent = node.parentNode;
			var json = html2json(html);
			var childs = json2dom(json, this);
			console.log(
				'%cDOM 操作 拦截 outerHTML : ' + (html.length > 100 ? (html.slice(0, 100) + '...') : html),
				'color: #606666;background-color: lightblue;padding: 5px 10px;'
			);
			for (var child of childs) {
				parent.insertBefore(child, node);
			}
			node.remove();
		}
	});

	function json2dom (json, root) {
		var isSvg = root && root instanceof SVGElement || json.tag === 'svg';
		var node;

		if (json.node === 'element' || json.node === 'root') {
			if (isSvg) {
				node = document.createElementNS(SVG_NS, json.tag);
			} else {
				node = document.createElement(json.tag || 'div');
			}
			var attr = json.attr || {};
			for (var key in attr) {
				if (Array.isArray(attr[key])) {
					attr[key] = attr[key].join(' ');
				}
				if (hasEscaped(attr[key], 2)) {
					attr[key] = replaceEscaped(attr[key], 2);
				}
				node.setAttribute(key, attr[key], 'custom');
			}
		} else if (json.node === 'text') {
			for (var i = 1; i < 4; i++) {
				if (hasEscaped(json.text, i)) {
					json.text = replaceEscaped(json.text, i);
				}
			}
			node = document.createTextNode(json.text);
		}

		if (json.child) {
			for (var ele of json.child) {
				if (ele.node === 'comment') continue;
				var dom = json2dom(ele, node);
				dom._type_ = 'custom';
				node.appendChild(dom);
			}
		}

		if (json.node !== 'root') {
			return node;
		}
		return Array.from(node.childNodes);
	}

	function hasEscaped (text, index) {
		if (index === 1) {
			return /&\w+/.test(text);
		}
		if (index === 2) {
			return /&#\d+;/.test(text);
		}
		if (index === 3) {
			return /&#x\w+;/.test(text);
		}
	}

	function replaceEscaped (text, index) {
		if (index === 1) {
			for (var key in escaped) {
				if (text.indexOf(key) >= 0) {
					text = text.replaceAll(key, escaped[key]);
				}
				var prefix = key.slice(0, -1);
				if (text.indexOf(prefix) >= 0) {
					text = text.replaceAll(prefix, escaped[key]);
				}
			}
			return text;
		}
		if (index === 2) {
			return text.replaceAll(/&#\d+;/g, function (part) {
				return String.fromCharCode(part.slice(2, -1) * 1);
			});
		}
		if (index === 3) {
			return text.replaceAll(/&#x\w+;/g, function (part) {
				return String.fromCharCode(parseInt(part.slice(3, -1), 16));
			});
		}
	}

	function removeChilds (node) {
		var childs = Array.from(node.childNodes || []);
		childs.forEach(function (child) {
			child.remove();
		});
	}

	function getNodeName (node) {
		return (node.nodeName || node.tagName || '').toLowerCase();
	}

	function getAttacher (node) {
		return getNodeName(node) === 'template' ? node.content : node;
	}

	function domLog (node, funcName) {
		var link = getNodeUrl(node)[0];
		if (link) {
			console.log(
				'%cDOM 操作 拦截 ' + funcName + ' : ' + node.nodeName.toLowerCase() + ' - ' + link,
				'color: #606666;background-color: yellow;padding: 5px 10px;'
			);
			window.domUrls.push(link);
		}
	}

	function srcLog (tag, urlAttr, url) {
		console.log(
			`%cDOM 操作 拦截 ${tag} ${urlAttr} : ` + url,
			'color: #606666;background-color: lime;padding: 5px 10px;'
		);
	}

	window.addEventListener('load', replaceNodesUrls);
	setTimeout(replaceNodesUrls, 1000);
	setTimeout(replaceNodesUrls, 2000);
	setInterval(replaceNodesUrls, 3000);

	// 事件绑定的 this 对象拦截替换
	var wael = window.addEventListener;
	window.addEventListener = function () {
		if (arguments[0] === __window__) arguments[0] = window;
		return wael.apply(window, arguments);
	}
	var wrel = window.removeEventListener;
	window.removeEventListener = function () {
		if (arguments[0] === __window__) arguments[0] = window;
		return wrel.apply(window, arguments);
	}
	var dael = document.addEventListener;
	document.addEventListener = function () {
		if (arguments[0] === __document__) arguments[0] = document;
		return dael.apply(document, arguments);
	}
	var drel = document.removeEventListener;
	document.removeEventListener = function () {
		if (arguments[0] === __document__) arguments[0] = document;
		return drel.apply(document, arguments);
	}

	var logger = console.log;
	console.log = function () {
		var isCustom = arguments[0] === 'custom';
		var ignore = isCustom || typeof arguments[0] !== 'string';

		var title = '';
		var shouldLog = true;
		if (!ignore && arguments.length === 2) {
			title = arguments[0].split(':')[0];
			title = title.indexOf('拦截') < 0 ? '' : title;
			if (title) {
				shouldLog = logTypes.some(function (type) {
					return title.indexOf(type) >= 0;
				});
			}
		}
		if (title) {
			groupLogs(title, arguments);
			if (!interceptLog || !shouldLog) {
				return ;
			}
		}

		logger.apply(console, arguments);
	}

	var logs = webvpn.logs = {
		all: function () {
			var allLogs = [];
			for (var key in logs) {
				if (typeof logs[key] === 'function') {
					continue ;
				}
				for (var sub in logs[key]) {
					allLogs = allLogs.concat(logs[key][sub]);
				}
			}
			return allLogs;
		},
		query: function (keyword) {
			var allLogs = this.all();
			return allLogs.filter(function (log) {
				return typeof log === 'string' && log.indexOf(keyword) >= 0;
			});
		}
	};

	function groupLogs (title, args) {
		args = Array.from(args);
		title = title.trim().replace('%c', '');
		var category = title.split(' ')[0];
		var type = title.split('拦截')[1].trim();
		logs[category] = logs[category] || {};
		logs[category][type] = logs[category][type] || [];

		if (args.length === 2 && args[0].startsWith('%c')) {
			args = args[0].slice(2);
		}
		logs[category][type].push(args);
	}

	webvpn.log = logger;

})();
