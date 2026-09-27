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
      script.onload = resolve
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

  const { sleep, addStyle, addScript, decodeUrl, blobs, siteUrl } = webvpn

  const provideDownloads = async (url, blob, type, name) => {
    let box = document.querySelector('#-pd-')
    if (!box) {
      addStyle(`
        #-pd- { position: fixed; z-index: 999999; font-size: 14px; box-sizing: border-box; left: 10px; top: 10px; width: 50px; height: 30px; padding: 10px; background-color: white; box-shadow: 0 0 5px 5px rgba(60, 150, 150, 0.5); color: #303333; overflow: hidden; border-radius: 4px; }
        #-pd- .flex-center { display: flex; align-items: center; justify-content: center; }
        #-pd- .mask { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 1000000; background-color: white; text-align: center; font-size: 13px; }
        #-pd-:hover { width: 360px; height: auto; max-height: 50vh; overflow-y: scroll; }
        #-pd-:hover .mask { display: none; }
        #-pd- .item { border-bottom: 1px solid #a0aaaa; padding-bottom: 5px; margin-bottom: 7px; display: none; }
        #-pd-:hover .item { display: flex; }
        #-pd- .item:last-child { border-bottom: 0; padding-bottom: 0; margin-bottom: 0; }
        #-pd- .title { flex: 1; }
        #-pd- .link { flex: 5; color: orange; cursor: pointer; display: inline-block; width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #-pd- .link:hover { color: orangered; text-decoration: underline; }
      `)
      box = document.createElement('div')
      box.id = '-pd-'
      document.body.appendChild(box)
      const mask = document.createElement('div')
      mask.classList.add('mask', 'flex-center')
      mask.innerHTML = '媒体0'
      box.appendChild(mask)
    }
    const mask = box.querySelector('.mask')
    mask.textContent = '媒体' + (mask.textContent.slice(2) * 1 + 1)
    const item = document.createElement('div')
    item.classList.add('item', 'flex-center')
    const isVideo = type === 'video'
    item.innerHTML = `<span class="title">${isVideo ? '视频' : '音频'}-${name}</span>`
    const link = document.createElement('a')
    link.classList.add('link')
    link.href = url
    link.textContent = url
    link.title = url
    link.onclick = e => {
      e.preventDefault()
      download(url, blob, isVideo ? `视频-${name}.mp4` : `音频-${name}.mp3`)
    }
    item.appendChild(link)
    box.appendChild(item)
  }

  const download = async (url, blob, filename) => {
    if (!window.saveAs) {
      await addScript(siteUrl + '/public/filesaver.js')
    }
    if (blob) {
      await downloadBlob(blob, filename)
    } else {
      await saveAs(url, filename)
    }
  }

  const downloadBlob = async (blob, filename) => {
    if (blob instanceof MediaSource) {
      downloadMediaSource(blob, filename)
      return 
    }
    const file = new File([blob], filename)
    saveAs(file, filename)
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
