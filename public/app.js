(() => {
  const playAllBtn = document.getElementById("play-all-btn");
  const stopBtn = document.getElementById("stop-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const speedRange = document.getElementById("speed-range");
  const speedValue = document.getElementById("speed-value");
  const statusLine = document.getElementById("status-line");
  const newsList = document.getElementById("news-list");
  const updatedAtEl = document.getElementById("updated-at");

  const synth = window.speechSynthesis;
  const speechSupported = !!synth;

  let articles = [];
  let japaneseVoice = null;
  let playQueueIndex = -1;
  let isPlayingAll = false;
  let isPlayingSingle = false;

  function pickJapaneseVoice() {
    if (!speechSupported) return;
    const voices = synth.getVoices();
    japaneseVoice =
      voices.find((v) => v.lang === "ja-JP") ||
      voices.find((v) => v.lang && v.lang.startsWith("ja")) ||
      null;
  }

  if (speechSupported) {
    pickJapaneseVoice();
    synth.addEventListener("voiceschanged", pickJapaneseVoice);
  }

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

  function buildUtteranceText(article) {
    const parts = [article.title];
    if (article.summary) parts.push(article.summary);
    return parts.join("。 ");
  }

  function speak(text, { onend } = {}) {
    if (!speechSupported) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    if (japaneseVoice) utterance.voice = japaneseVoice;
    utterance.rate = parseFloat(speedRange.value) || 1;
    utterance.onend = () => onend && onend();
    utterance.onerror = () => onend && onend();
    synth.speak(utterance);
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
    if (speechSupported) synth.cancel();
    isPlayingAll = false;
    isPlayingSingle = false;
    playQueueIndex = -1;
    highlightItem(-1);
    playAllBtn.textContent = "▶ すべて読み上げる";
    stopBtn.disabled = true;
    setStatus(`${articles.length}件のニュースがあります`);
  }

  function playNextInQueue() {
    playQueueIndex += 1;
    if (playQueueIndex >= articles.length) {
      stopAll();
      return;
    }
    highlightItem(playQueueIndex);
    setStatus(`読み上げ中: ${playQueueIndex + 1} / ${articles.length}`);
    speak(buildUtteranceText(articles[playQueueIndex]), { onend: playNextInQueue });
  }

  function startPlayAll() {
    if (!speechSupported) {
      setStatus("お使いのブラウザは読み上げに対応していません");
      return;
    }
    if (articles.length === 0) return;
    synth.cancel();
    isPlayingAll = true;
    isPlayingSingle = false;
    playQueueIndex = -1;
    playAllBtn.textContent = "⏸ 読み上げ中...";
    stopBtn.disabled = false;
    playNextInQueue();
  }

  function playSingle(index) {
    if (!speechSupported) {
      setStatus("お使いのブラウザは読み上げに対応していません");
      return;
    }
    synth.cancel();
    isPlayingAll = false;
    isPlayingSingle = true;
    highlightItem(index);
    stopBtn.disabled = false;
    setStatus(`読み上げ中: 記事 ${index + 1}`);
    speak(buildUtteranceText(articles[index]), {
      onend: () => {
        if (isPlayingSingle) stopAll();
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

  async function loadNews({ forceRefresh = false } = {}) {
    setStatus("読み込み中...");
    refreshBtn.disabled = true;
    try {
      const res = await fetch(`/api/news${forceRefresh ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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

  if (!speechSupported) {
    playAllBtn.disabled = true;
    setStatus("お使いのブラウザは読み上げ(Web Speech API)に対応していません");
  }

  loadNews();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
