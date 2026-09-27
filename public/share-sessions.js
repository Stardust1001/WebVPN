(async function () {
  if (top !== window) return

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const report = async () => {
    try {
      await fetch(webvpn.siteUrl + '/share-sessions?shareId=' + webvpn.shareId, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ cookie: document.cookie, localStorage: { ...localStorage } })
      })
    } catch {}
  }

  // 此前仅延迟 3s 上报一次，之后 cookie/localStorage 变化无法同步给 share 会话。
  // 改为定期上报：页面隐藏/卸载时立即上报一次，可见时每 10s 上报一次。
  let stopped = false
  const tick = async () => {
    if (stopped) return
    await report()
    await sleep(document.hidden ? 30000 : 10000)
    tick()
  }
  setTimeout(tick, 3000)

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !stopped) report()
  })
  // beforeunload 中 fetch 可能被浏览器中止，改用 sendBeacon 保证可靠送达
  window.addEventListener('beforeunload', () => {
    stopped = true
    try {
      navigator.sendBeacon(
        webvpn.siteUrl + '/share-sessions?shareId=' + webvpn.shareId,
        new Blob([JSON.stringify({ cookie: document.cookie, localStorage: { ...localStorage } })], { type: 'application/json' })
      )
    } catch {}
  })
})();
