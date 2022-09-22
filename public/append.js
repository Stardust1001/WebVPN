(function () {

	if (window.location._href) {
		return
	}

	var logTypes = ['AJAX', 'fetch', 'History'];

	var site = window.webvpn.site;
	var siteHostname = window.webvpn.siteHostname;
	var siteOrigin = window.webvpn.siteOrigin;
	var sitePathname = window.webvpn.sitePathname;

	var targetUrl = window.webvpn.targetUrl;
	var target = new URL(targetUrl);

	var proxyType = window.webvpn.proxyType;
	var interceptLog = window.webvpn.interceptLog;
	var disableJump = window.webvpn.disableJump;
	var confirmJump = window.webvpn.confirmJump;
	var pathDir = target.pathname.endsWith('/') ? target.pathname : (target.pathname.split('/').slice(0, -1).join('/') + '/');

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
		if (url == null) {
			return url;
		}
		url = url.toString().trim();
		for (var prefix of ignoredPrefixes) {
			if (url.startsWith(prefix)) {
				return url;
			}
		}
		if (url.startsWith('http')) {
			var u = null;
			try {
				u = new URL(url);
			} catch {
				console.log('%c 链接转换错误：' + url, 'background-color: red; color: white; padding: 5px 10px;');
				return url;
			}
			if (u.hostname === siteHostname) {
				if (url.startsWith(siteOrigin + '/public/')) {
					return url;
				} else if (url.startsWith(siteOrigin + '/proxy/')) {
					var path = url.split('/proxy/' + proxyType + '/')[1];
					if (path.indexOf('%3Aptth') > 0 || path.indexOf('%3Asptth') > 0) {
						return url;
					}
					url = target.origin + pathDir + path;
				}
			}
		}
		if (url.startsWith('/proxy/')) {
			return url;
		}
		if (url.startsWith('//')) {
			url = target.protocol + url;
		}
		if (!url.startsWith('http')) {
			url = url[0] === '/' ? (target.origin + url) : (target.origin + pathDir + url);
		}
		var encodeUrl = encodeURIComponent(url.split('').reverse().join(''));
		return sitePathname + '/' + proxyType + (url[0] === '/' ? '' : '/') + encodeUrl;
	}

	function decodeUrl (url) {
		if (url.startsWith(siteOrigin)) {
			try {
				url = new URL(url).pathname;
			} catch {
				return url;
			}
		}
		url = url.split('/').slice(3).join('/');
		url = decodeURIComponent(url).split('').reverse().join('');
		url = url.split(' ')[0];
		return url;
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
			url = (node.getAttribute(attr) || '').trim();
			urlAttr = attr;
			if (url) {
				break;
			}
		}
		return [url, urlAttr];
	}

	function replaceNodesUrls (root) {
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
				replaceNodeUrl(root, node);
				return ;
			}
			attrs.forEach(function (attr) {
				replaceNodeUrl(root, node, attr);
			});
			customReplaceNodeUrl(node, attrs);
		});
	}

	function customReplaceNodeUrl (node, attrs) {
		// 无法100%完全转发网站并保证原网站代码的100%正常运行
		// 比如 play.google.com 的图片显示不出来，src 没有，data-src 有
		// 可能是部分代码运行异常导致图片显示不了，这里就帮着显示下
		attrs.forEach(function (attr) {
			if (!node[attr] && node.dataset[attr]) {
				node[attr] = node.dataset[attr];
			}
			// 有的网站里面代码生成的链接，原本该是 javascript:func()，因为各种原因，生成了 Http 链接并以 /proxy/ 开头
			if (node.node_name === 'a' && node.href.indexOf('%3Atpircsavaj') > 0) {
				if (node.href.indexOf('%3B%3Atpircsavaj') > 0) {
					node.href = 'javascript:;';
					return ;
				}
				if (node.href.indexOf('(') < 0) {
					node.href = 'javascript:;';
					return ;
				}
				var href = node.href.split('(')[1].split(')')[0];
				var parts = href.indexOf('%25ptth') > 0 ? href.split('%25ptth') : href.split('%25sptth');
				var func = decodeURIComponent(parts[0]).split(':tpircsavaj')[0].split('').reverse().join('');
				node.href = 'javascript:' + func + '(' + parts[1] + ');';
			}
		});
	}

	function replaceNodeUrl (root, node, attr) {
		var url = '';
		var urlAttr = '';
		if (attr) {
			url = node.getAttribute(attr);
			urlAttr = attr;
		} else {
			var link = getNodeUrl(node);
			url = link[0];
			urlAttr = link[1];
		}
		if (!checkUrlShouldReplace(url, attr)) {
			return ;
		}
		if (attr !== 'srcset' && proxyType !== 'single' && replaceThirdDomainUrl(node, urlAttr, url)) {
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
				node.setAttribute(urlAttr, newUrl);
			} else {
				var copy = node.cloneNode(true);
				copy.src = newUrl;
				node.parentNode.appendChild(copy);
				node.remove();
			}
		}
	}

	function checkUrlShouldReplace (url, attr) {
		if (attr === 'srcset') {
			return !!url;
		}
		if (!url) {
			return false;
		}
		if (url.startsWith(siteOrigin)) {
			return false;
		}
		// /proxy/ 开头的是当前网站代理开头的地址，此链接无需转换
		if (url.startsWith('/proxy/')) {
			return false;
		}
		if (url.indexOf('javascript:') >= 0) {
			return false
		}
		if (proxyType === 'single') {
			if (url.indexOf('//') >= 0 && (url.split('//')[1] || '').split('/')[0] !== target.hostname) {
				return false;
			}
		}
		if (url.indexOf('data:') >= 0) {
			return false;
		}
		return true;
	}

	function replaceThirdDomainUrl (node, urlAttr, url) {
		var newUrl = transformUrl(url);
		var domain = '';
		try {
			domain = new URL(newUrl).hostname;
		} catch {}
		if (domain !== target.hostname && domain !== siteHostname) {
			if (url !== newUrl) {
				node[urlAttr] = newUrl;
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
	Node.prototype.appendChild = function (node, type) {
		if (!(node instanceof Node)) {
			return
		}
		if (type !== 'custom') {
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
		return open.bind(this)(url, name, specs, replace);
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
		return go.bind(this)(value);
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

	// window._location
	window._location = Object.assign({}, copySource(window.location), copySource(target));
	window._location.assign = window.location._assign;
	window._location.replace = window.location._replace;

	// location._href, _location._href 拦截
	for (var key of ['location', '_location']) {
		Object.defineProperty(window[key], '_href', {
			get () {
				return window._location.href;
			},
			set (url) {
				console.log(
					'%c' + key + ' 拦截 _href : ' + url,
					'color: #606666;background-color: #f56c6c;padding: 5px 10px;'
				);
				if (!canJump(url)) return false;
				url = transformUrl(url);
				window.location.href = url;
			}
		});
	}
	// _location.href 拦截
	var href = window._location.href;
	Object.defineProperty(window._location, 'href', {
		get () {
			return href;
		},
		set (url) {
			console.log(
				'%c_location 拦截 href : ' + url,
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

	// _window, _document, _globalThis, _parent, _self, _top
	var locationCon = ['window', 'document'];
	for (var con of locationCon) {
		window['_' + con] = new Proxy(window[con], {
			get (target, property, receiver) {
				if (property === 'location') {
					return window._location;
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
				return value;
			}
		});
	}
	window._globalThis = window._parent = window._self = window._top = window._window;

	// 因为用 _document 替换了 document, _document 的时候类型跟 document 不一致
	var observe = MutationObserver.prototype.observe;
	MutationObserver.prototype.observe = function (target, options) {
		if (target == window._document) {
			target = document;
		}
		return observe.bind(this)(target, options);
	}

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
			set (url) {
				srcLog(item[1], item[2], url);
				this.setAttribute(item[2], transformUrl(url), 'custom');
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
		return write.apply(this, htmls);
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
		return writeln.apply(this, htmls);
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
				node.appendChild(json2dom(ele), 'custom');
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

	// remove 拦截
	var remove = Element.prototype.remove;
	Element.prototype.remove = function () {
		domLog(this, 'remove');
		return remove.apply(this, arguments);
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

		logger.apply(this, arguments);
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

		if (args.length === 2 && args[0].startsWith('%c')) {
			args = [args[0].slice(2)];
		}

		logs[category][type] = (logs[category][type] || []).concat(args);
	}

})();
