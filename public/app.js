(() => {
  const playAllBtn = document.getElementById("play-all-btn");
  const stopBtn = document.getElementById("stop-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const speedRange = document.getElementById("speed-range");
  const speedValue = document.getElementById("speed-value");
  const pitchRange = document.getElementById("pitch-range");
  const pitchValue = document.getElementById("pitch-value");
  const voiceSelect = document.getElementById("voice-select");
  const voiceTestBtn = document.getElementById("voice-test-btn");
  const voiceModeHint = document.getElementById("voice-mode-hint");
  const statusLine = document.getElementById("status-line");
  const newsList = document.getElementById("news-list");
  const updatedAtEl = document.getElementById("updated-at");

  const synth = window.speechSynthesis;
  const speechSupported = !!synth;

  // 自前サーバー (server.js) が動いていない場合でもブラウザだけで動かせるよう、
  // 公開のCORSプロキシ経由でRSSを直接取得するフォールバックを用意する
  const CACHE_KEY = "news-reader-cache-v1";
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_ARTICLES = 40;
  const FEEDS = [
    { url: "https://www3.nhk.or.jp/rss/news/cat0.xml", source: "NHKニュース" },
    { url: "https://news.yahoo.co.jp/rss/topics/top-picks.xml", source: "Yahoo!ニュース" },
    { url: "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja", source: "Googleニュース" },
  ];
  const CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];

  const DEVICE_VOICE_KEY = "news-reader-voice-v1";
  const CLOUD_VOICE_KEY = "news-reader-cloud-voice-v1";

  // server.js に GOOGLE_TTS_API_KEY が設定されている場合に使える、
  // Google Cloud Text-to-Speech の高品質な日本語音声
  const CLOUD_VOICES = [
    { name: "ja-JP-Neural2-B", label: "Neural2-B(女性・高品質)" },
    { name: "ja-JP-Neural2-C", label: "Neural2-C(男性・高品質)" },
    { name: "ja-JP-Neural2-D", label: "Neural2-D(男性・高品質)" },
    { name: "ja-JP-Wavenet-A", label: "Wavenet-A(女性)" },
    { name: "ja-JP-Wavenet-B", label: "Wavenet-B(女性)" },
    { name: "ja-JP-Wavenet-C", label: "Wavenet-C(男性)" },
    { name: "ja-JP-Wavenet-D", label: "Wavenet-D(男性)" },
  ];

  let articles = [];
  let japaneseVoices = [];
  let selectedVoice = null;
  let selectedCloudVoiceName = CLOUD_VOICES[0].name;
  let ttsMode = "device"; // "cloud" | "device"
  let currentAudio = null;
  let playQueueIndex = -1;
  let isPlayingAll = false;
  let isPlayingSingle = false;

  // 端末に入っている音声エンジンの質はまちまちなので、名前から品質の高そうな
  // 音声(ネットワーク音声・高品質版など)を優先的にデフォルト選択する
  function voiceQualityScore(voice) {
    const name = voice.name || "";
    let score = 0;
    if (/google/i.test(name)) score += 3;
    if (/enhanced|premium|neural|natural|wavenet/i.test(name)) score += 3;
    if (/kyoko|otoya|o-ren|siri/i.test(name)) score += 2;
    if (voice.lang === "ja-JP") score += 1;
    return score;
  }

  function populateDeviceVoiceList() {
    if (!speechSupported) return;
    const voices = synth.getVoices().filter((v) => v.lang && v.lang.startsWith("ja"));
    japaneseVoices = voices
      .slice()
      .sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a) || a.name.localeCompare(b.name));

    if (japaneseVoices.length === 0) return;

    const savedName = localStorage.getItem(DEVICE_VOICE_KEY);
    voiceSelect.innerHTML = "";
    japaneseVoices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voice.name;
      voiceSelect.appendChild(option);
    });

    const savedVoice = savedName && japaneseVoices.find((v) => v.name === savedName);
    selectedVoice = savedVoice || japaneseVoices[0];
    voiceSelect.value = selectedVoice.name;
  }

  function populateCloudVoiceList() {
    const savedName = localStorage.getItem(CLOUD_VOICE_KEY);
    voiceSelect.innerHTML = "";
    CLOUD_VOICES.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voice.label;
      voiceSelect.appendChild(option);
    });
    const saved = savedName && CLOUD_VOICES.find((v) => v.name === savedName);
    selectedCloudVoiceName = (saved || CLOUD_VOICES[0]).name;
    voiceSelect.value = selectedCloudVoiceName;
  }

  // server.js の /api/tts に軽いリクエストを送り、Google Cloud TTSが
  // 使える状態かどうかを判定する(空文字は400になるため、サーバーに
  // 到達してAPIキーも設定されていれば400、キー未設定なら501が返る)
  async function probeCloudTts() {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      return res.status === 400;
    } catch {
      return false;
    }
  }

  async function initVoiceMode() {
    const cloudAvailable = await probeCloudTts();
    if (cloudAvailable) {
      ttsMode = "cloud";
      populateCloudVoiceList();
      voiceModeHint.textContent = "Google Cloudの高品質な音声を使用しています";
    } else {
      ttsMode = "device";
      if (speechSupported) {
        populateDeviceVoiceList();
        voiceModeHint.textContent =
          "端末組み込みの音声を使用しています(自前サーバーでGOOGLE_TTS_API_KEYを設定すると、より自然な音声が使えます)";
      } else {
        voiceModeHint.textContent = "";
      }
    }

    if (!ttsAvailable()) {
      playAllBtn.disabled = true;
      voiceTestBtn.disabled = true;
      voiceSelect.disabled = true;
      setStatus("お使いのブラウザは読み上げに対応していません");
    }
  }

  if (speechSupported) {
    synth.addEventListener("voiceschanged", () => {
      if (ttsMode === "device") populateDeviceVoiceList();
    });
  }
  initVoiceMode();

  function setStatus(text) {
    statusLine.textContent = text;
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function buildUtteranceParts(article) {
    // タイトルと本文を別々の発話に分けることで、一続きで読み上げるより
    // 自然な「間」ができる
    const parts = [article.title];
    if (article.summary) parts.push(article.summary);
    return parts;
  }

  function pitchSemitones() {
    // 声の高さスライダー(0.5〜1.5、1.0が標準)をGoogle Cloud TTSの
    // ピッチ単位(半音、-20〜20)に変換する
    return (parseFloat(pitchRange.value) - 1) * 20;
  }

  // Google Cloud TTS側はサーバーでSSMLの<break>に変換してもらうため、
  // テキストをそのまま渡せば1回のリクエストでスペースごとの間が入る
  async function speakOneCloud(text, token) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceName: selectedCloudVoiceName,
          speakingRate: parseFloat(speedRange.value) || 1,
          pitch: pitchSemitones(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (token !== playToken) return; // 取得中に停止/次の再生が始まった
      const objectUrl = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        const audio = new Audio(objectUrl);
        currentAudio = audio;
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(objectUrl);
      currentAudio = null;
    } catch (err) {
      console.error("[news-reader] クラウド音声の再生に失敗しました:", err);
      currentAudio = null;
    }
  }

  function speakUtterance(text) {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = (selectedVoice && selectedVoice.lang) || "ja-JP";
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = parseFloat(speedRange.value) || 1;
      utterance.pitch = parseFloat(pitchRange.value) || 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      synth.speak(utterance);
    });
  }

  const WORD_PAUSE_MS = 150;

  // Web Speech APIはSSMLの間(ま)が使えないため、スペースで区切って
  // 短い発話に分け、その間に一拍おく
  async function speakOneDevice(text, token) {
    if (!speechSupported) return;
    const words = text.split(/[ 　]+/).filter(Boolean);
    const segments = words.length > 0 ? words : [text];
    for (let i = 0; i < segments.length; i++) {
      await speakUtterance(segments[i]);
      if (token !== playToken) return;
      if (i < segments.length - 1) {
        await new Promise((r) => setTimeout(r, WORD_PAUSE_MS));
        if (token !== playToken) return;
      }
    }
  }

  function speakOne(text, token) {
    return ttsMode === "cloud" ? speakOneCloud(text, token) : speakOneDevice(text, token);
  }

  const PAUSE_BETWEEN_PARTS_MS = 250;
  let playToken = 0;

  function ttsAvailable() {
    return ttsMode === "cloud" || speechSupported;
  }

  async function speak(parts, token, { onend } = {}) {
    if (!ttsAvailable()) return;
    for (let i = 0; i < parts.length; i++) {
      await speakOne(parts[i], token);
      if (token !== playToken) return; // 途中で停止/次の再生が開始された
      if (i < parts.length - 1) {
        await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_PARTS_MS));
        if (token !== playToken) return;
      }
    }
    onend && onend();
  }

  function highlightItem(index) {
    document.querySelectorAll(".news-item").forEach((el, i) => {
      el.classList.toggle("is-playing", i === index);
    });
    if (index >= 0) {
      const el = newsList.children[index];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function stopAll() {
    playToken += 1; // 実行中の発話チェーンを無効化する
    if (speechSupported) synth.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    isPlayingAll = false;
    isPlayingSingle = false;
    playQueueIndex = -1;
    highlightItem(-1);
    playAllBtn.textContent = "▶ すべて読み上げる";
    stopBtn.disabled = true;
    setStatus(`${articles.length}件のニュースがあります`);
  }

  function playNextInQueue(token) {
    if (token !== playToken) return;
    playQueueIndex += 1;
    if (playQueueIndex >= articles.length) {
      stopAll();
      return;
    }
    highlightItem(playQueueIndex);
    setStatus(`読み上げ中: ${playQueueIndex + 1} / ${articles.length}`);
    speak(buildUtteranceParts(articles[playQueueIndex]), token, {
      onend: () => playNextInQueue(token),
    });
  }

  function startPlayAll() {
    if (!ttsAvailable()) {
      setStatus("お使いのブラウザは読み上げに対応していません");
      return;
    }
    if (articles.length === 0) return;
    playToken += 1;
    const token = playToken;
    if (speechSupported) synth.cancel();
    isPlayingAll = true;
    isPlayingSingle = false;
    playQueueIndex = -1;
    playAllBtn.textContent = "⏸ 読み上げ中...";
    stopBtn.disabled = false;
    playNextInQueue(token);
  }

  function playSingle(index) {
    if (!ttsAvailable()) {
      setStatus("お使いのブラウザは読み上げに対応していません");
      return;
    }
    playToken += 1;
    const token = playToken;
    if (speechSupported) synth.cancel();
    isPlayingAll = false;
    isPlayingSingle = true;
    highlightItem(index);
    stopBtn.disabled = false;
    setStatus(`読み上げ中: 記事 ${index + 1}`);
    speak(buildUtteranceParts(articles[index]), token, {
      onend: () => {
        if (token === playToken && isPlayingSingle) stopAll();
      },
    });
  }

  function renderArticles() {
    newsList.innerHTML = "";
    articles.forEach((article, index) => {
      const li = document.createElement("li");
      li.className = "news-item";

      const top = document.createElement("div");
      top.className = "news-item-top";
      top.innerHTML = `<span>${article.source}</span><span>${formatDate(article.pubDate)}</span>`;

      const title = document.createElement("h2");
      title.className = "news-title";
      title.textContent = article.title;

      const summary = document.createElement("p");
      summary.className = "news-summary";
      summary.textContent = article.summary;

      const actions = document.createElement("div");
      actions.className = "news-item-actions";

      const playBtn = document.createElement("button");
      playBtn.className = "btn";
      playBtn.type = "button";
      playBtn.textContent = "🔊 この記事を読む";
      playBtn.addEventListener("click", () => playSingle(index));

      const link = document.createElement("a");
      link.className = "btn news-link";
      link.href = article.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "記事を開く";

      actions.append(playBtn, link);
      li.append(top, title, summary, actions);
      newsList.appendChild(li);
    });
  }

  function stripHtml(html) {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeTitle(title) {
    return (title || "").trim().toLowerCase();
  }

  // server.js が動いている場合はそちらを優先する(自前サーバーなので信頼性が高い)。
  // 到達できなければ null を返し、ブラウザ単体のフォールバックに進む。
  async function fetchFromOwnApi(forceRefresh) {
    try {
      const res = await fetch(`/api/news${forceRefresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.articles)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function fetchRssViaProxy(url) {
    let lastErr;
    for (const buildProxyUrl of CORS_PROXIES) {
      try {
        const res = await fetch(buildProxyUrl(url), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.length < 20) throw new Error("empty response");
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("all proxies failed");
  }

  function parseRssItems(xmlText, sourceName) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML parse error");
    return Array.from(doc.querySelectorAll("item")).map((item) => ({
      title: (item.querySelector("title")?.textContent || "").trim(),
      link: (item.querySelector("link")?.textContent || "").trim(),
      source: sourceName,
      pubDate: item.querySelector("pubDate")?.textContent?.trim() || null,
      summary: stripHtml(item.querySelector("description")?.textContent || ""),
    }));
  }

  function mergeFilterAndSort(articleLists) {
    const merged = articleLists.flat();

    const seenTitles = new Set();
    const deduped = [];
    for (const article of merged) {
      if (!article.title || !article.link) continue;
      const key = normalizeTitle(article.title);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      deduped.push(article);
    }

    const filtered = deduped.filter(
      (article) =>
        !window.NewsFilter.isCrimeArticle(article.title) &&
        !window.NewsFilter.isCrimeArticle(article.summary)
    );

    filtered.sort((a, b) => {
      const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return dateB - dateA;
    });

    return filtered.slice(0, MAX_ARTICLES);
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
      // ストレージが使えなくても無視する(読み上げ自体には影響しない)
    }
  }

  // 自前サーバーなしでブラウザだけで動かすためのフォールバック。
  // 公開のCORSプロキシを経由するため、自前サーバー経由より信頼性は落ちる。
  async function fetchNewsClientSide(forceRefresh) {
    if (!forceRefresh) {
      const cached = readCache();
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return { updatedAt: new Date(cached.fetchedAt).toISOString(), articles: cached.articles };
      }
    }

    const settled = await Promise.allSettled(
      FEEDS.map(async (feed) => parseRssItems(await fetchRssViaProxy(feed.url), feed.source))
    );
    const succeeded = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (succeeded.length === 0) {
      throw new Error("すべてのニュース取得元への接続に失敗しました");
    }

    const articlesResult = mergeFilterAndSort(succeeded);
    const fetchedAt = Date.now();
    writeCache({ fetchedAt, articles: articlesResult });
    return { updatedAt: new Date(fetchedAt).toISOString(), articles: articlesResult };
  }

  async function loadNews({ forceRefresh = false } = {}) {
    setStatus("読み込み中...");
    refreshBtn.disabled = true;
    try {
      const data =
        (await fetchFromOwnApi(forceRefresh)) || (await fetchNewsClientSide(forceRefresh));
      articles = data.articles || [];
      renderArticles();
      setStatus(
        articles.length > 0
          ? `${articles.length}件のニュースがあります`
          : "表示できるニュースがありません"
      );
      if (data.updatedAt) {
        updatedAtEl.textContent = `最終更新: ${formatDate(data.updatedAt)}`;
      }
    } catch (err) {
      console.error(err);
      setStatus("ニュースの取得に失敗しました。時間をおいて再度お試しください。");
    } finally {
      refreshBtn.disabled = false;
    }
  }

  playAllBtn.addEventListener("click", () => {
    if (isPlayingAll) {
      stopAll();
    } else {
      startPlayAll();
    }
  });

  stopBtn.addEventListener("click", stopAll);

  refreshBtn.addEventListener("click", () => {
    stopAll();
    loadNews({ forceRefresh: true });
  });

  speedRange.addEventListener("input", () => {
    speedValue.textContent = parseFloat(speedRange.value).toFixed(1);
  });

  pitchRange.addEventListener("input", () => {
    pitchValue.textContent = parseFloat(pitchRange.value).toFixed(1);
  });

  voiceSelect.addEventListener("change", () => {
    if (ttsMode === "cloud") {
      const voice = CLOUD_VOICES.find((v) => v.name === voiceSelect.value);
      if (!voice) return;
      selectedCloudVoiceName = voice.name;
      localStorage.setItem(CLOUD_VOICE_KEY, voice.name);
    } else {
      const voice = japaneseVoices.find((v) => v.name === voiceSelect.value);
      if (!voice) return;
      selectedVoice = voice;
      localStorage.setItem(DEVICE_VOICE_KEY, voice.name);
    }
  });

  voiceTestBtn.addEventListener("click", () => {
    playToken += 1;
    if (speechSupported) synth.cancel();
    speak(["これはテスト再生です。ニュースはこのような声で読み上げられます。"], playToken);
  });

  loadNews();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
