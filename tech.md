## DOM AJAX History 等拦截，修改原型链对应的方法

## innerHTML outerHTML 等拦截，修改属性的 set 方法, Object.defineProperty

## 不要直接迭代 childNodes，有的好像迭代不出来，先转换为数组，Array.from

## 有链接的元素 ['a', 'img', 'script', 'link', 'video', 'audio', 'source', 'iframe', 'form', 'embed', 'object'];
## 是链接的属性 ['href', 'src', 'srcset', 'poster', 'action', 'data', 'codebase'];

## img 有 srcset、sizes 属性，可在 img 元素代码内做响应式图片，根据不同屏幕尺寸显示不同尺寸的图片
## picture 元素像 audio video ，可以指定不同格式的图片，比如 webp，picture 也可以做响应式图片

## prepend append before after 是属于 DOM4 的标准

## html 转DOM树，可以先 htmlparser 解析，然后用一个小插件 html2json 把 html 代码转为表示 dom 树的 json
## 可以再根据 json 添加DOM树到文档上 html2json json2dom

## html5 有新的 template 元素，想要操作其内容，需通过其 .content 属性

## History 修改 url 不刷新页面的方法 pushState replaceState

## element.insertAdjacentHTML(position, text), position ['beforebegin', 'afterbegin', 'beforeend', 'afterend']

## TrustedHTML TrustedScript TrustedScriptURL ...

## 跨域隔离 COOP COEP CORP 等 响应头，防止 Spectre 漏洞
### 这个漏洞影响 SharedArrayBuffer, performance.measureMemory, JS Self-Profiling API, performance.now(), performance.timeOrigin

## 往DOM树上增加、替换元素的操作：
### appendChild insertBefore replaceChild
### replaceChildren prepend append before after
### insertAdjacentHTML
### innerHTML outerHTML
### document.write document.writeln

## import ... from, import(...), import"...", import'...'

## 跳转页面的代码：
### window.location =
### window.navigate() // 旧 IE
### (window.)location.href =
### (window.)location.assign()
### (window.)location.replace()

## 有的链接里还有 &#x，是被编码的中文等字符, str.replace(/&#x/g, '%')

## 有的链接里出现多余的 %25，需要 str.replace('%25', '%')

## 中文字符范围 /[\u4e00-\u9fa5]/

## 遍历DOM树
### document.createTreeWalker NodeFilter

## 视频，如 mp4，浏览器请求过程：
### Sec-Fetch-Dest: document 服务器返回 200，并且标明是 mp4 视频
### Sec-Fetch-Dest: video 服务器返回 206，两端分段传输 mp4 视频

## hls 视频流：
### m3u8 是个表示视频分段信息等内容的格式，不是视频本身，视频本身是 ts
### m3u8 有个主文件，标明有哪些 m3u8 次文件
### 选个 m3u8 次文件，里面有标明分段的哪些 ts 文件
### 请求 ts 文件才是分段视频


## koa 多进程，可使用 cluster

## 把一个请求的 res 直接转给响应ctx：
### ctx.res.writeHead(res.statusCode, res.headers)
### res.pipe(ctx.res)
### res.on('end', resolve) // 当然，这是一个 promise

## ctx.request 对象上，没有 POST 请求参数，用下 koa-bodyparser

## node.js console 颜色，使用 chalk 库

## 字符集编码，用 iconv-lite，decode 方法的参数是一个 Buffer

### 错误 SSL routines:ssl3_get_record:wrong version number，因为目标网址不支持 https，需要改成 http 访问
