(function () {

	if (window.location.__href__) {
		return
	}

	var logTypes = ['AJAX', 'fetch', 'History'];

	var site = window.webvpn.site;
	var siteHostname = window.webvpn.siteHostname;
	var siteOrigin = window.webvpn.siteOrigin;
	var base = window.webvpn.base;
	var vpnDomain = new URL(site).hostname.replace('www', '');

	var targetUrl = window.webvpn.targetUrl;
	var target = new URL(targetUrl);

	var interceptLog = window.webvpn.interceptLog;
	var disableJump = window.webvpn.disableJump;
	var confirmJump = window.webvpn.confirmJump;

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

	Object.assign(window.webvpn, {
		transformUrl,
		decodeUrl,
		transformArgumentsNodes,
		transformNode,
		transformHtml,
		getNodeUrl,
		replaceNodesUrls,
		replaceNodeUrl,
		customReplaceNodeUrl,
		checkUrlShouldReplace,
		replaceThirdDomainUrl,
		canJump,
		json2dom,
		removeChilds,
		getNodeName,
		hasChinease,
		convertChinease,
		convertChineaseText,
		getAttacher
	});

	var ignoredPrefixes = ['mailto:', 'sms:', 'tel:', 'javascript:', 'data:', 'blob:'];

	function transformUrl (url) {
		url = (url ? url.toString() : '').trim();
		if (!url || url.split('?')[0].indexOf('//') < 0) {
			return url;
		}
		if (url.indexOf(vpnDomain) > 0) {
			if (url.startsWith('http')) {
				return url.replace('https://', 'http://')
			}
			return url;
		}
		for (var prefix of ignoredPrefixes) {
			if (url.indexOf(prefix) >= 0) {
				return url;
			}
		}
		if (url.startsWith('//')) {
			url = 'https:' + url;
		}
		var u = new URL(url);
		var subdomain = window.base32.encode(u.host);
		return siteOrigin.replace('www', subdomain) + u.pathname + u.search;
	}

	function decodeUrl (url) {
		url = (url || '').trim();
		if (!url) {
			return url;
		}
		if (url.split('?')[0].indexOf('http') < 0) {
			return window.location.origin + url;
		}
		var u = new URL(url);
		var host = window.base32.decode(u.host.split('.')[0]);
		return window.location.protocol + '//' + host + u.pathname + u.search;
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

	function transformHtml (html) {
		var json = html2json(html);
		var childs = json2dom(json);
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
			customReplaceNodeUrl(node, attrs, type);
		});
	}

	function customReplaceNodeUrl (node, attrs, type) {
		// 无法100%完全转发网站并保证原网站代码的100%正常运行
		// 比如 play.google.com 的图片显示不出来，src 没有，data-src 有
		// 可能是部分代码运行异常导致图片显示不了，这里就帮着显示下
		attrs.forEach(function (attr) {
			if (!node.getAttribute(attr, type) && node.dataset[attr]) {
				node.setAttribute(attr, node.dataset[attr], type);
			}
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
		if (attr !== 'srcset' && replaceThirdDomainUrl(node, urlAttr, url, type)) {
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

	function replaceThirdDomainUrl (node, urlAttr, url, type) {
		var newUrl = transformUrl(url);
		var domain = '';
		try {
			domain = new URL(newUrl).hostname;
		} catch {}
		if (domain !== target.hostname && domain !== siteHostname) {
			if (url !== newUrl) {
				node.setAttribute(urlAttr, newUrl, type)
			}
			return true;
		}
		return false;
	}

	// ajax 拦截
	var xhrOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
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
				'%cDOM 操作 拦截 setAttribute : ' + value,
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
		html = transformHtml(html);
		return insertAdjacentHTML.bind(this)(position, html);
	}

	// a 元素 click 拦截
	var aOnClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		console.log(
			'%cDOM History 操作 拦截 a click : ' + a.href,
			'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
		);
		if (!canJump(a.href)) return false;
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
		return go.bind(History)(value);
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
	window.__location__ = Object.assign({}, copySource(window.location), copySource(target));
	window.__location__.assign = window.location._assign;
	window.__location__.replace = window.location._replace;

	// location.__href__, __location__.__href__ 拦截
	for (var key of ['location', '__location__']) {
		Object.defineProperty(window[key], '__href__', {
			get () {
				return window.__location__.href;
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
	var href = window.__location__.href;
	Object.defineProperty(window.__location__, 'href', {
		get () {
			return href;
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
			return target.hostname;
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
	var locationCon = ['window', 'document'];
	for (var con of locationCon) {
		window['__' + con + '__'] = new Proxy(window[con], {
			get (target, property, receiver) {
				if (property === 'location') {
					return window.__location__;
				}
				var value = target[property];
				// 如果 value 是 function，不一定是真的函数，也可能是 Promise 这种，Promise 有 prototype
				return (typeof value === 'function' && !value.prototype) ? value.bind(target) : value;
			},
			set (target, property, value) {
				if (property === 'location') {
					console.log(
						'%clocation 操作 拦截 location = : ' + value,
						'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
					);
					if (!canJump(url)) return;
					url = transformUrl(url);
					window.location.href = url;
					return url;
				}
				target[property] = value;
				return true;
			}
		});
	}
	window.__globalThis__ = window.__parent__ = window.__self__ = window.__top__ = window.__window__;

	// 因为用 __document__ 替换了 document, __document__ 的时候类型跟 document 不一致
	var observe = MutationObserver.prototype.observe;
	MutationObserver.prototype.observe = function (target, options) {
		if (target == window.__document__) {
			target = document;
		}
		return observe.bind(this)(target, options);
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
					'%cDOM 操作 拦截 getAttribute : ' + item[1] + '-' + item[2] + ' ' + value,
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

	nodeAttrSetters.forEach(function (item) {
		Object.defineProperty(item[0].prototype, item[2], {
			get () {
				var value = this.getAttribute(item[2], 'custom');
				console.log(
					'%cDOM 操作 拦截 ' + item[1] + ' ' + item[2] + ' getter : ' + value,
					'color: #606666;background-color: lime;padding: 5px 10px;'
				);
				return decodeUrl(value);
			},
			set (url) {
				srcLog(item[1], item[2], url);
				this.setAttribute(item[2], transformUrl(url), 'custom');
			}
		});
	});

	// a 元素的 host 等 URL 属性 拦截, href 在上面的 get 函数里拦截了
	var aUrlAttrs = ['host', 'hostname', 'origin', 'port', 'protocol'];
	aUrlAttrs.forEach(function (attr) {
		Object.defineProperty(HTMLAnchorElement.prototype, attr, {
			get () {
				console.log(
					'%cDOM 操作 拦截 a ' + attr + ' getter',
					'color: #606666;background-color: lime;padding: 5px 10px;'
				);
				var url = decodeUrl(this.getAttribute('href', 'custom'));
				if (!url) {
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
			htmls.push(transformHtml(html));
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
			htmls.push(transformHtml(html));
		}
		console.log(
			'%cDOM 操作 拦截 document.writeln : ' + htmls,
			'color: #606666;background-color: lightblue;padding: 5px 10px;'
		);
		return writeln.apply(document, htmls);
	}

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
			var json = html2json(html);
			var childs = json2dom(json);
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
			var childs = json2dom(json);
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

	function json2dom (json) {
		var node;

		if (json.node === 'element' || json.node === 'root') {
			node = document.createElement(json.tag || 'div');
			var attr = json.attr || {};
			for (var key in attr) {
				node.setAttribute(key, attr[key], 'custom');
			}
		} else if (json.node === 'text') {
			node = document.createTextNode(json.text);
		}

		if (json.child) {
			for (var ele of json.child) {
				var dom = json2dom(ele);
				dom._type_ = 'custom';
				node.appendChild(dom);
			}
		}

		if (json.node !== 'root') {
			return node;
		}
		return Array.from(node.childNodes);
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
				'%cDOM 操作 拦截 ' + funcName + ' : ' + link,
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

	// [\u4e00-\u9fa5]
	var chineaseRegexp = /\#[\u4e01-\u9fa6]\#/g;
	function hasChinease (text) {
		return chineaseRegexp.test(text);
	}

	function convertChinease () {
		var root = document.documentElement;
		var has = hasChinease(root.innerHTML);
		if (!has) {
			return ;
		}
		var walker = null;
		var n = null;

		walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
		while (n = walker.nextNode()) {
			var text = n.nodeValue;
			if (hasChinease(text)) {
				n.nodeValue = convertChineaseText(text);
			}
		}

		walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
		var attrs = [];
		while (n = walker.nextNode()) {
			attrs = Array.from(n.attributes || []);
			attrs.forEach(function (attr) {
				var text = attr.value;
				if (hasChinease(text)) {
					attr.value = convertChineaseText(text);
				}
			});
		}
	}

	function convertChineaseText (text) {
		var matches = Array.from(new Set(text.match(chineaseRegexp)));
		matches.forEach(function (match) {
			var chinease = String.fromCharCode(match[1].charCodeAt(0) - 1);
			text = text.replaceAll(match, chinease);
		});
		return text;
	}

	window.addEventListener('load', convertChinease);
	setTimeout(convertChinease, 1000);
	setTimeout(convertChinease, 2000);
	setInterval(convertChinease, 3000);

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

	window.logs = {
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
			args = [args[0].slice(2)];
		}
		logs[category][type].push(args);
	}

})();
