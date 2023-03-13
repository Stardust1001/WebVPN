(async function () {

	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	const addStyle = src => {
		let node;
		if (src.startsWith('http')) {
			node = document.createElement('link');
			node.rel = 'stylesheet';
			node.href = src;
		} else {
			node = document.createElement('style');
			node.innerHTML = src;
		}
		return new Promise(resolve => {
			node.onload = resolve;
			document.head.appendChild(node);
		});
	}

	const addScript = src => {
		const script = document.createElement('script');
		if (src.startsWith('http')) {
			script.src = src;
		} else {
			script.innerHTML = src;
		}
		return new Promise(resolve => {
			script.onload = resolve;
			document.body.appendChild(script);
		});
	}

	Object.assign(webvpn, {
		sleep,
		addStyle,
		addScript,
		blobs: {}
	});

	const cou = URL.createObjectURL;
	URL.createObjectURL = object => {
		const url = cou.call(this, object);
		webvpn.blobs[url] = object;
		return url;
	}

	const appendBuffer = SourceBuffer.prototype.appendBuffer;
	SourceBuffer.prototype.appendBuffer = buf => {
		this._buffer = this._buffer ? unionBuffers([this._buffer, buf]) : buf;
		appendBuffer.call(this, buf);
	}

	const unionBuffers = buffers => {
		buffers = Array.from(buffers);
		const sum = buffers.reduce((sum, buf) => {
			return sum + buf.length;
		}, 0);
		const union = new Uint8Array(sum);
		const index = 0;
		buffers.forEach(buf => {
			union.set(buf, index);
			index += buf.length;
		});
		return union;
	}

})();

(async function () {

	const { sleep, addStyle, addScript, decodeUrl, blobs, site } = webvpn;

	const provideDownloads = async (url, blob, type, name) => {
		let box = document.querySelector('#-pd-');
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
			`);
			box = document.createElement('div');
			box.id = '-pd-';
			document.body.appendChild(box);
			const mask = document.createElement('div');
			mask.classList.add('mask', 'flex-center');
			mask.innerHTML = '媒体0';
			box.appendChild(mask);
		}
		const mask = box.querySelector('.mask');
		mask.textContent = '媒体' + (mask.textContent.slice(2) * 1 + 1);
		const item = document.createElement('div');
		item.classList.add('item', 'flex-center');
		const isVideo = type === 'video';
		item.innerHTML = `<span class="title">${isVideo ? '视频' : '音频'}-${name}</span>`
		const link = document.createElement('span');
		link.classList.add('link');
		link.textContent = url;
		link.title = url;
		link.onclick = () => download(url, blob, isVideo ? `视频-${name}.mp4` : `音频-${name}.mp3`);
		item.appendChild(link);
		box.appendChild(item);
	}

	const download = async (url, blob, filename) => {
		if (!window.saveAs) {
			await addScript(site + 'public/filesaver.js');
		}
		if (blob) {
			await downloadBlob(blob, filename);
		} else {
			await saveAs(url, filename);
		}
	}

	const downloadBlob = async (blob, filename) => {
		if (blob instanceof MediaSource) {
			downloadMediaSource(blob, filename)
			return ;
		}
		const file = new File([blob], filename);
		saveAs(file, filename);
	}

	const downloadMediaSource = (mediaSource, filename) => {
		const blobs = Array.from(mediaSource.sourceBuffers).map(ele => new Blob([ele._buffer]));
		if (!blobs.length) return ;
		let [audio, video] = blobs;
		if (!audio || !video) {
			video = audio || video;
			downloadBlob(video, filename);
			return ;
		}
		if (audio.size > video.site) {
			[video, audio] = [audio, video];
		}
		downloadBlob(audio, filename.replace('视频', '音频').replace('mp4', 'mp3'));
		downloadBlob(video, filename);
	}

	const medias = [];

	const checkMediaUrl = (url, type) => {
		if (!medias.includes(url)) {
			medias.push(url);
			provideDownloads(url, blobs[url], type, medias.length);
		}
	}

	window.addEventListener('load', () => {
		Array.from([
			...document.querySelectorAll('video'),
			...document.querySelectorAll('audio')
		]).forEach(node => {
			checkMediaUrl(node.src, node.nodeName.toLowerCase());
		});
	});

	webvpn.download = download;
	webvpn.medias = medias;

	while (true) {
		Array.from([
			...(logs?.DOM?.['audio src'] ?? []),
			...(logs?.DOM?.['video src'] ?? [])
		]).forEach(text => {
			const url = text.split('src : ')[1];
			const type = text.includes('audio src') ? 'audio' : 'video';
			checkMediaUrl(url, type);
		});
		await sleep(1000);
	}

})();
