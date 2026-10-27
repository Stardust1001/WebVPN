(async function () {

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const addStyle = src => {
    let node
    if (src.startsWith('http')) {
      node = document.createElement('link')
      node.rel = 'stylesheet'
      node.href = src
    } else {
      node = document.createElement('style')
      node.innerHTML = src
    }
    return new Promise(resolve => {
      node.onload = resolve
      document.head.appendChild(node)
    })
  }

  const addScript = src => {
    const script = document.createElement('script')
    if (src.startsWith('http')) {
      script.src = src
    } else {
      script.innerHTML = src
    }
    return new Promise(resolve => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      script.onload = finish
      script.onerror = finish
      setTimeout(finish, 30000)
      document.body.appendChild(script)
    })
  }

  Object.assign(webvpn, {
    sleep,
    addStyle,
    addScript
  })

  const unionBuffers = buffers => {
    buffers = Array.from(buffers)
    const sum = buffers.reduce((sum, buf) => {
      return sum + buf.length
    }, 0)
    const union = new Uint8Array(sum)
    let index = 0
    buffers.forEach(buf => {
      union.set(buf, index)
      index += buf.length
    })
    return union
  }

  const appendBuffer = SourceBuffer.prototype.appendBuffer
  // 必须用 function 而非箭头函数：SourceBuffer 实例通过 this 绑定，
  // 箭头函数的 this 是词法作用域（外层 IIFE 的 this，通常为 window），会导致 _buffer 缓存到错误对象上
  SourceBuffer.prototype.appendBuffer = function (buf) {
    this._buffer = this._buffer ? unionBuffers([this._buffer, buf]) : buf
    appendBuffer.call(this, buf)
  }

})();

(async function () {

  const downloads = []

  const aOnClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      if (this.origin === webvpn.location.origin) {
        // same origin download file
        downloads.push([this.href, this.download, 'a-click'])
      }
    }
    return aOnClick.apply(this, arguments)
  }

  webvpn.downloads = downloads

})();

(async function () {

  const { sleep, addStyle, blobs } = webvpn

  /* ==================== 下载实现 ==================== */

  // 原生下载：a[download] + dispatchEvent。代理环境下 URL 经 href 拦截器编码为本站同源域名，
  // download 属性必然生效，浏览器直接流式落盘。
  // 不用 FileSaver 处理 URL 字符串：其跨域分支会发同步 XHR HEAD（无超时，页面会整体冻结），
  // 再把整个文件读进内存才保存，大视频必然卡死。
  const saveFile = (source, filename) => {
    const a = document.createElement('a')
    a.href = typeof source === 'string' ? source : URL.createObjectURL(source)
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.dispatchEvent(new MouseEvent('click'))
    a.remove()
    if (typeof source !== 'string') {
      setTimeout(() => URL.revokeObjectURL(a.href), 40000)
    }
  }

  const download = (url, blob, filename) => {
    if (blob) {
      downloadBlob(blob, filename)
    } else {
      saveFile(url, filename)
    }
  }

  const downloadBlob = (blob, filename) => {
    if (blob instanceof MediaSource) {
      downloadMediaSource(blob, filename)
      return
    }
    saveFile(blob, filename)
  }

  const downloadMediaSource = (mediaSource, filename) => {
    const blobs = Array.from(mediaSource.sourceBuffers).map(ele => new Blob([ele._buffer]))
    if (!blobs.length) return
    let [audio, video] = blobs
    if (!audio || !video) {
      video = audio || video
      downloadBlob(video, filename)
      return
    }
    if (audio.size > video.size) {
      [video, audio] = [audio, video]
    }
    downloadBlob(audio, filename.replaceAll('视频', '音频').replaceAll('mp4', 'mp3'))
    downloadBlob(video, filename)
  }

  /* ==================== 悬浮面板 UI（深色玻璃风格，可拖动 / 可固定） ==================== */

  const PIN_KEY = '-pd-pinned-'
  const POS_KEY = '-pd-position-'

  const icon = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

  const ICONS = {
    logo: icon('<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M2.5 9h19M7.5 4v5M16.5 4v5"/>'),
    video: icon('<rect x="2" y="6" width="14" height="12" rx="2.5"/><path d="m16 10.5 6-3.5v10l-6-3.5"/>'),
    audio: icon('<path d="M9 18V5.5L21 3v12.5"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="15.5" r="3"/>'),
    download: icon('<path d="M12 3v11"/><path d="m7 9.5 5 5 5-5"/><path d="M4 20.5h16"/>'),
    link: icon('<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/>'),
    trash: icon('<path d="M4 7h16"/><path d="M9.5 7V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="m6.5 7 .8 12.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>')
  }

  const PANEL_CSS = `
    #-pd- { position: fixed; left: 12px; top: 12px; z-index: 2147483000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: 13px; line-height: 1.5; color: #e8eaf0; text-align: left; direction: ltr; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
    #-pd-, #-pd- *, #-pd- *::before, #-pd- *::after { box-sizing: border-box; margin: 0; padding: 0; }
    #-pd- button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    #-pd- svg { display: block; }

    /* 折叠态胶囊：图标 + 计数徽标，可拖动，点击固定面板 */
    #-pd- .-pd-pill- { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px; background: rgba(26, 30, 42, .88); box-shadow: 0 4px 14px rgba(0, 0, 0, .25), inset 0 0 0 1px rgba(255, 255, 255, .08); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; transition: background-color .2s ease, box-shadow .2s ease, transform .2s ease; }
    #-pd- .-pd-pill-:hover { background: rgba(36, 42, 58, .95); box-shadow: 0 6px 18px rgba(0, 0, 0, .3), inset 0 0 0 1px rgba(255, 255, 255, .12); transform: translateY(-1px); }
    #-pd- .-pd-pill-:active, #-pd-.-pd-dragging- .-pd-pill- { cursor: grabbing; transform: none; }
    #-pd- .-pd-pill- > svg { width: 15px; height: 15px; color: #67e0ff; }
    #-pd- .-pd-label- { font-size: 12px; color: #aab3c5; }
    #-pd- .-pd-count- { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: linear-gradient(135deg, #22c1ee, #6366f1); font-size: 11px; font-weight: 600; color: #fff; display: inline-flex; align-items: center; justify-content: center; }
    @keyframes -pd-pulse- { 0% { transform: scale(1); } 40% { transform: scale(1.3); } 100% { transform: scale(1); } }
    #-pd- .-pd-count-.-pd-pulse- { animation: -pd-pulse- .35s ease; }
    /* 悬停桥：填补胶囊与面板之间的空隙，鼠标斜向移动时展开状态不闪断 */
    #-pd- .-pd-pill-::after { content: ''; position: absolute; top: 100%; left: -40px; width: calc(100% + 80px); height: 10px; }
    #-pd-.-pd-bottom- .-pd-pill-::after { top: auto; bottom: 100%; }

    /* 展开面板 */
    #-pd- .-pd-panel- { position: absolute; top: calc(100% + 8px); left: 0; width: 372px; max-width: calc(100vw - 24px); border-radius: 12px; overflow: hidden; background: rgba(23, 26, 36, .92); box-shadow: 0 12px 32px rgba(0, 0, 0, .35), inset 0 0 0 1px rgba(255, 255, 255, .08); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); opacity: 0; visibility: hidden; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease, visibility 0s linear .16s; }
    #-pd-:hover .-pd-panel-, #-pd-.-pd-pin- .-pd-panel- { opacity: 1; visibility: visible; transform: translateY(0); transition-delay: 0s; }
    /* 胶囊位于屏幕下半部分时面板改为向上展开 */
    #-pd-.-pd-bottom- .-pd-panel- { top: auto; bottom: calc(100% + 8px); }
    #-pd-.-pd-bottom-:not(:hover):not(.-pd-pin-) .-pd-panel- { transform: translateY(-6px); }
    #-pd-.-pd-dragging- .-pd-panel- { opacity: 0 !important; visibility: hidden !important; }

    /* 面板头部（同时是拖拽手柄） */
    #-pd- .-pd-head- { display: flex; align-items: center; gap: 4px; padding: 9px 12px; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; background: linear-gradient(90deg, rgba(103, 224, 255, .1), rgba(99, 102, 241, .1)); border-bottom: 1px solid rgba(255, 255, 255, .07); }
    #-pd-.-pd-dragging- .-pd-head- { cursor: grabbing; }
    #-pd- .-pd-title- { flex: 1; display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: #fff; }
    #-pd- .-pd-title- svg { width: 15px; height: 15px; color: #67e0ff; }
    #-pd- .-pd-act- { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: #aab3c5; transition: background-color .15s ease, color .15s ease; }
    #-pd- .-pd-act- svg { width: 13px; height: 13px; }
    #-pd- .-pd-act-:hover { background: rgba(255, 255, 255, .1); color: #fff; }

    /* 列表与条目 */
    #-pd- .-pd-list- { max-height: min(46vh, 420px); overflow-y: auto; overscroll-behavior: contain; }
    #-pd- .-pd-list-::-webkit-scrollbar { width: 8px; }
    #-pd- .-pd-list-::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 4px; background-color: rgba(255, 255, 255, .16); background-clip: content-box; }
    #-pd- .-pd-list-::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, .28); }
    #-pd- .-pd-item- { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid rgba(255, 255, 255, .06); transition: background-color .15s ease; animation: -pd-slide-in- .25s ease; }
    @keyframes -pd-slide-in- { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
    #-pd- .-pd-item-:hover { background: rgba(255, 255, 255, .04); }
    #-pd- .-pd-item-:last-child { border-bottom: 0; }
    #-pd- .-pd-type- { flex: none; width: 30px; height: 30px; margin-top: 2px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; }
    #-pd- .-pd-type- svg { width: 16px; height: 16px; }
    #-pd- .is-video .-pd-type- { background: rgba(99, 102, 241, .2); color: #94a0ff; }
    #-pd- .is-audio .-pd-type- { background: rgba(34, 193, 238, .16); color: #5fd8f7; }
    #-pd- .-pd-main- { flex: 1; min-width: 0; }
    #-pd- .-pd-row1- { display: flex; align-items: baseline; gap: 8px; }
    #-pd- .-pd-name- { font-weight: 600; color: #fff; word-break: break-all; }
    #-pd- .-pd-size- { flex: none; font-size: 11px; color: #8b94a7; }
    #-pd- .-pd-url- { margin-top: 1px; font-size: 12px; color: #7fb8ff; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #-pd- .-pd-url-:hover { color: #a9cdff; text-decoration: underline; }
    #-pd- .-pd-status- { display: none; margin-top: 2px; font-size: 11px; color: #8b94a7; }
    #-pd- .-pd-status-:not(:empty) { display: block; }
    #-pd- .-pd-status-.ok { color: #34d399; }
    #-pd- .-pd-status-.err { color: #f87171; }
    /* 条目操作按钮：悬停/聚焦时浮现，触屏设备常显 */
    #-pd- .-pd-ops- { flex: none; display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .15s ease; }
    #-pd- .-pd-item-:hover .-pd-ops-, #-pd- .-pd-item-:focus-within .-pd-ops- { opacity: 1; }
    @media (pointer: coarse) { #-pd- .-pd-ops- { opacity: 1; } }
    #-pd- .-pd-op- { width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: #aab3c5; transition: background-color .15s ease, color .15s ease; }
    #-pd- .-pd-op- svg { width: 14px; height: 14px; }
    #-pd- .-pd-op-:hover { background: rgba(255, 255, 255, .1); color: #fff; }
    #-pd- .-pd-del-:hover { background: rgba(248, 113, 113, .16); color: #f87171; }
    #-pd- .-pd-busy- .-pd-do- { pointer-events: none; opacity: .45; }

    /* 空状态与提示气泡 */
    #-pd- .-pd-empty-tip- { display: none; padding: 20px 12px; text-align: center; font-size: 12px; color: #8b94a7; }
    #-pd-.-pd-empty- .-pd-empty-tip- { display: block; }
    #-pd-.-pd-empty- .-pd-list- { display: none; }
    #-pd- .-pd-toast- { position: fixed; left: 16px; bottom: 20px; padding: 7px 14px; border-radius: 8px; background: rgba(26, 30, 42, .92); color: #e8eaf0; font-size: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .3), inset 0 0 0 1px rgba(255, 255, 255, .08); opacity: 0; pointer-events: none; }
    @keyframes -pd-toast- { 0% { opacity: 0; transform: translateY(6px); } 10%, 80% { opacity: 1; transform: none; } 100% { opacity: 0; } }
    #-pd- .-pd-toast-.-pd-toast-run- { animation: -pd-toast- 1.8s ease forwards; }
  `

  // 面板状态
  const items = []
  let box = null
  let badge = null
  let listEl = null
  let toastEl = null
  let pos = { left: 12, top: 12 }
  let downloadingAll = false

  const formatBytes = n => {
    if (!isFinite(n) || n < 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024
      i++
    }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i]
  }

  const toast = text => {
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.classList.remove('-pd-toast-run-')
    void toastEl.offsetWidth
    toastEl.classList.add('-pd-toast-run-')
  }

  const setStatus = (item, text, kind) => {
    if (!item.statusEl) return
    item.statusEl.textContent = text || ''
    item.statusEl.classList.toggle('ok', kind === 'ok')
    item.statusEl.classList.toggle('err', kind === 'err')
  }

  const copyText = async text => {
    try {
      await navigator.clipboard.writeText(text)
      toast('链接已复制到剪贴板')
    } catch {
      const input = document.createElement('textarea')
      input.value = text
      input.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(input)
      input.select()
      try {
        document.execCommand('copy')
        toast('链接已复制到剪贴板')
      } catch {
        toast('复制失败，请手动复制')
      }
      input.remove()
    }
  }

  const updateBadge = () => {
    if (!badge) return
    badge.textContent = String(items.length)
    box.classList.toggle('-pd-empty-', !items.length)
    if (items.length) {
      badge.classList.remove('-pd-pulse-')
      void badge.offsetWidth
      badge.classList.add('-pd-pulse-')
    }
  }

  const removeItem = item => {
    const index = items.indexOf(item)
    if (index >= 0) items.splice(index, 1)
    // 同步从 medias 移除，使同一 url 后续再次出现时能重新加入列表
    const mediaIndex = medias.indexOf(item.url)
    if (mediaIndex >= 0) medias.splice(mediaIndex, 1)
    if (item.el) item.el.remove()
    updateBadge()
  }

  const clearAll = () => {
    if (!items.length) {
      toast('列表为空')
      return
    }
    items.splice(0).forEach(item => item.el && item.el.remove())
    medias.length = 0
    updateBadge()
    toast('已清空列表')
  }

  const doDownload = async item => {
    if (item.busy) return
    item.busy = true
    item.el.classList.add('-pd-busy-')
    const filename = item.type === 'video' ? `视频-${item.name}.mp4` : `音频-${item.name}.mp3`
    setStatus(item, '下载中…')
    try {
      await download(item.url, item.blob, filename)
      setStatus(item, '已发起下载 ✓', 'ok')
    } catch (err) {
      setStatus(item, '下载失败：' + ((err && err.message) || err || '未知错误'), 'err')
    }
    item.busy = false
    item.el.classList.remove('-pd-busy-')
    setTimeout(() => {
      if (!item.busy) setStatus(item, '')
    }, 2500)
  }

  const downloadAll = async () => {
    if (downloadingAll) return
    const pending = items.filter(item => !item.busy)
    if (!pending.length) {
      toast(items.length ? '全部都在下载中' : '列表为空')
      return
    }
    downloadingAll = true
    try {
      for (const item of pending) {
        await doDownload(item)
        // 间隔发起，避免浏览器拦截连续下载
        await sleep(300)
      }
      toast('全部下载已完成')
    } finally {
      downloadingAll = false
    }
  }

  // 应用位置：夹取到视口内；位于下半屏时面板向上展开；save 为真时持久化
  const applyPos = save => {
    if (!box) return
    const width = window.innerWidth
    const height = window.innerHeight
    if (!isFinite(pos.left)) pos.left = 12
    if (!isFinite(pos.top)) pos.top = 12
    pos.left = Math.min(Math.max(6, pos.left), Math.max(6, width - 70))
    pos.top = Math.min(Math.max(6, pos.top), Math.max(6, height - 44))
    box.style.left = pos.left + 'px'
    box.style.top = pos.top + 'px'
    box.classList.toggle('-pd-bottom-', pos.top > height / 2)
    if (save) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch {}
    }
  }

  const togglePin = () => {
    const pinned = box.classList.toggle('-pd-pin-')
    try { localStorage.setItem(PIN_KEY, pinned ? '1' : '0') } catch {}
  }

  // 拖动手柄：移动超过 5px 视为拖拽，否则视为点击（onClick）
  const makeDraggable = (handle, onClick) => {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const originLeft = pos.left
      const originTop = pos.top
      let moved = false
      const onMove = ev => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < 5) return
        moved = true
        box.classList.add('-pd-dragging-')
        pos.left = originLeft + dx
        pos.top = originTop + dy
        applyPos()
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        if (!moved) {
          onClick && onClick()
          return
        }
        applyPos(true)
        box.classList.remove('-pd-dragging-')
      }
      try { handle.setPointerCapture(e.pointerId) } catch {}
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    })
  }

  const buildPanel = () => {
    addStyle(PANEL_CSS)
    box = document.createElement('div')
    box.id = '-pd-'
    box.innerHTML = `
      <div class="-pd-pill-" title="媒体下载：悬停展开，点击固定/取消固定 · 按住可拖动">
        ${ICONS.logo}<span class="-pd-label-">媒体</span><span class="-pd-count-">0</span>
      </div>
      <div class="-pd-panel-">
        <div class="-pd-head-">
          <span class="-pd-title-">${ICONS.logo}媒体下载</span>
          <button class="-pd-act- -pd-act-all-" title="依次下载列表中的全部媒体">${ICONS.download}<span>全部</span></button>
          <button class="-pd-act- -pd-act-clear-" title="清空列表">${ICONS.trash}<span>清空</span></button>
        </div>
        <div class="-pd-list-"></div>
        <div class="-pd-empty-tip-">暂无媒体<br>播放页面中的音视频后会自动添加到这里</div>
      </div>
      <div class="-pd-toast-" role="status"></div>`
    document.body.appendChild(box)

    badge = box.querySelector('.-pd-count-')
    listEl = box.querySelector('.-pd-list-')
    toastEl = box.querySelector('.-pd-toast-')

    // 面板内的点击不再向页面冒泡，避免触发被代理网站自己的全局事件（如 data-api 委托点击）
    box.addEventListener('click', e => e.stopPropagation())
    box.addEventListener('pointerdown', e => e.stopPropagation())

    makeDraggable(box.querySelector('.-pd-pill-'), togglePin)
    makeDraggable(box.querySelector('.-pd-head-'), null)

    box.querySelector('.-pd-act-all-').addEventListener('click', downloadAll)
    box.querySelector('.-pd-act-clear-').addEventListener('click', clearAll)

    // 恢复上次的固定状态与位置
    try { if (localStorage.getItem(PIN_KEY) === '1') box.classList.add('-pd-pin-') } catch {}
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY))
      if (saved && isFinite(saved.left) && isFinite(saved.top)) pos = saved
    } catch {}
    applyPos()
    updateBadge()
    window.addEventListener('resize', () => applyPos())
  }

  const ensurePanel = () => {
    if (!box) buildPanel()
  }

  const provideDownloads = async (url, blob, type, name) => {
    ensurePanel()
    const isVideo = type === 'video'
    const el = document.createElement('div')
    el.className = isVideo ? '-pd-item- is-video' : '-pd-item- is-audio'
    el.innerHTML = `
      <span class="-pd-type-">${isVideo ? ICONS.video : ICONS.audio}</span>
      <div class="-pd-main-">
        <div class="-pd-row1-">
          <span class="-pd-name-">${isVideo ? '视频' : '音频'}-${name}</span>
          <span class="-pd-size-"></span>
        </div>
        <div class="-pd-url-"></div>
        <div class="-pd-status-"></div>
      </div>
      <div class="-pd-ops-">
        <button class="-pd-op- -pd-do-" title="下载">${ICONS.download}</button>
        <button class="-pd-op- -pd-copy-" title="复制链接">${ICONS.link}</button>
        <button class="-pd-op- -pd-del-" title="移除">${ICONS.trash}</button>
      </div>`
    const sizeEl = el.querySelector('.-pd-size-')
    if (blob instanceof MediaSource) {
      sizeEl.textContent = '流媒体'
      sizeEl.title = 'MediaSource 流式媒体，下载时保存当前已缓冲的内容'
    } else if (blob && blob.size) {
      sizeEl.textContent = formatBytes(blob.size)
    }
    const urlEl = el.querySelector('.-pd-url-')
    urlEl.textContent = url
    urlEl.title = url + '（点击下载）'
    const statusEl = el.querySelector('.-pd-status-')
    const item = { url, blob, type, name, el, statusEl, busy: false }
    urlEl.addEventListener('click', () => doDownload(item))
    el.querySelector('.-pd-do-').addEventListener('click', () => doDownload(item))
    el.querySelector('.-pd-copy-').addEventListener('click', () => copyText(item.url))
    el.querySelector('.-pd-del-').addEventListener('click', () => removeItem(item))
    listEl.appendChild(el)
    items.push(item)
    updateBadge()
  }

  const medias = []

  const checkMediaUrl = (url, type) => {
    if (url && !medias.includes(url)) {
      medias.push(url)
      provideDownloads(url, blobs[url], type, medias.length)
    }
  }

  window.addEventListener('load', () => {
    Array.from([
      ...document.querySelectorAll('video'),
      ...document.querySelectorAll('audio')
    ]).forEach(node => {
      checkMediaUrl(node.src, node.nodeName.toLowerCase())
    })
  })

  webvpn.download = download
  webvpn.medias = medias

  // 此前是 while(true) 无限轮询，每秒全量扫描日志数组，既永不停止又重复处理已扫过的条目。
  // 改为：记录已扫描的偏移量，只处理增量；页面隐藏时拉长间隔节省 CPU；页面卸载时停止。
  const scanLogs = () => {
    const srcSetterLogs = [
      ...(webvpn.logs?.DOM?.['audio src'] ?? []),
      ...(webvpn.logs?.DOM?.['video src'] ?? [])
    ]
    for (let i = lastScannedSrcSetter; i < srcSetterLogs.length; i++) {
      const text = srcSetterLogs[i]
      const url = text.split('src : ')[1]
      const type = text.includes('audio src') ? 'audio' : 'video'
      checkMediaUrl(url, type)
    }
    lastScannedSrcSetter = srcSetterLogs.length

    const setAttrLogs = webvpn.logs?.DOM?.['setAttribute'] ?? []
    for (let i = lastScannedSetAttr; i < setAttrLogs.length; i++) {
      const text = setAttrLogs[i]
      if (!text.includes('audio - src') && !text.includes('video - src')) continue
      const [brief, attr, url] = text.split(' - ')
      const type = brief.split(' : ')[1]
      checkMediaUrl(url, type)
    }
    lastScannedSetAttr = setAttrLogs.length
  }

  let lastScannedSrcSetter = 0
  let lastScannedSetAttr = 0
  let stopped = false
  let delay = 1000

  const tick = async () => {
    if (stopped) return
    scanLogs()
    await sleep(delay)
    tick()
  }
  tick()

  // 页面隐藏时降低频率（5s），可见时恢复（1s）
  document.addEventListener('visibilitychange', () => {
    delay = document.hidden ? 5000 : 1000
  })
  // 页面卸载时停止轮询，避免泄露/报错
  window.addEventListener('beforeunload', () => { stopped = true })

})();
