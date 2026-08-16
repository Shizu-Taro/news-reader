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

  let articles = [];
  let japaneseVoices = [];
  let selectedVoice = null;
  let cloudVoices = []; // server.js の /api/tts/voices から取得した実際の日本語ボイス一覧
  let selectedCloudVoiceName = null;
  let ttsMode = "device"; // "cloud" | "device"
  let currentAudio = null;
  let stopCurrentAudio = null; // 再生中のクラウド音声を強制停止するための関数
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

  // ボイス名から世代・品質のランクを判定する(新しい世代ほど自然な声)
  function classifyVoiceTier(name) {
    if (/chirp3-hd/i.test(name)) return { tier: 4, label: "Chirp3-HD" };
    if (/studio/i.test(name)) return { tier: 3, label: "Studio" };
    if (/neural2/i.test(name)) return { tier: 2, label: "Neural2" };
    if (/wavenet/i.test(name)) return { tier: 1, label: "Wavenet" };
    return { tier: 0, label: "Standard" };
  }

  const GENDER_LABELS = { FEMALE: "女性", MALE: "男性", NEUTRAL: "" };

  function voiceDisplayLabel(voice) {
    const shortName = voice.name.replace(/^ja-JP-/, "");
    const genderLabel = GENDER_LABELS[voice.gender] || "";
    return genderLabel ? `${shortName}(${genderLabel})` : shortName;
  }

  function sortVoicesByQuality(voices) {
    return voices.slice().sort((a, b) => {
      const diff = classifyVoiceTier(b.name).tier - classifyVoiceTier(a.name).tier;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }

  function populateCloudVoiceList() {
    const savedName = localStorage.getItem(CLOUD_VOICE_KEY);
    voiceSelect.innerHTML = "";
    cloudVoices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voiceDisplayLabel(voice);
      voiceSelect.appendChild(option);
    });
    const saved = savedName && cloudVoices.find((v) => v.name === savedName);
    selectedCloudVoiceName = (saved || cloudVoices[0]).name;
    voiceSelect.value = selectedCloudVoiceName;
  }

  // server.js の /api/tts/voices からGoogle Cloud TTSの実際の日本語ボイス
  // 一覧を取得する。取得できればそれ自体が「利用可能」の判定にもなる
  // (APIキー未設定なら501、サーバーが無ければfetch自体が失敗する)
  async function fetchCloudVoices() {
    try {
      const res = await fetch("/api/tts/voices");
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.voices) || data.voices.length === 0) return null;
      return data.voices;
    } catch {
      return null;
    }
  }

  // ボタン類の有効/無効を、実際に読み上げが使える状態かどうかに合わせて更新する。
  // 端末に日本語音声が1つも無い場合はここでtrueにならないため、
  // 「端末組み込みの音声を使用しています」というヒントだけが表示され
  // 実際には選択肢が空、という食い違いを防げる。
  function updateTtsAvailability() {
    const available = ttsAvailable();
    playAllBtn.disabled = !available;
    voiceTestBtn.disabled = !available;
    voiceSelect.disabled = !available;
    if (!available) {
      setStatus("お使いの環境では読み上げに対応していません");
    }
  }

  function refreshDeviceVoiceState() {
    populateDeviceVoiceList();
    if (japaneseVoices.length === 0) {
      voiceModeHint.textContent =
        "この端末で使える日本語の読み上げ音声が見つかりませんでした。端末の設定で日本語音声をダウンロードしてください。";
    } else {
      voiceModeHint.textContent =
        "端末組み込みの音声を使用しています(自前サーバーでGOOGLE_TTS_API_KEYを設定すると、より自然な音声が使えます)";
    }
    updateTtsAvailability();
  }

  async function initVoiceMode() {
    const voices = await fetchCloudVoices();
    if (voices) {
      ttsMode = "cloud";
      cloudVoices = sortVoicesByQuality(voices);
      populateCloudVoiceList();
      voiceModeHint.textContent = "Google Cloudの高品質な音声を使用しています";
      updateTtsAvailability();
    } else {
      ttsMode = "device";
      if (speechSupported) {
        refreshDeviceVoiceState();
      } else {
        voiceModeHint.textContent = "";
        updateTtsAvailability();
      }
    }
  }

  if (speechSupported) {
    synth.addEventListener("voiceschanged", () => {
      if (ttsMode === "device") refreshDeviceVoiceState();
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
    // 自然な「間」ができる。空文字や空白だけの本文を発話に混ぜると、
    // 何も読まずに終わった発話を「失敗」と誤検知してしまうので取り除く。
    return [article.title, article.summary]
      .map((part) => (part || "").trim())
      .filter((part) => part.length > 0);
  }

  function pitchSemitones() {
    // 声の高さスライダー(0.5〜1.5、1.0が標準)をGoogle Cloud TTSの
    // ピッチ単位(半音、-20〜20)に変換する
    return (parseFloat(pitchRange.value) - 1) * 20;
  }

  // スペース(半角・全角)を句読点の「、」と同じ読み方にするため、
  // 読み上げ前にテキスト側で置き換えてしまう(サーバー側でも同様に変換される)。
  // ただし英単語同士の間のスペース(例: "Machine Learning")はそのまま読ませたい
  // ので変換しない。
  const SPACE_PLACEHOLDER = String.fromCharCode(0xe000);

  function spacesToComma(text) {
    const protectedText = text.replace(/(?<=[A-Za-z])[ 　]+(?=[A-Za-z])/g, SPACE_PLACEHOLDER);
    const converted = protectedText.replace(/[ 　]+/g, "、");
    return converted.split(SPACE_PLACEHOLDER).join(" ");
  }

  // 音声の取得・再生は、ネットワークの一瞬の不調やブラウザの音声エンジンの
  // 不具合で失敗することがある。失敗を無視してそのまま次に進むと「勝手に
  // スキップされた」ように見えてしまうため、一時的な失敗は自動で再試行する。
  const MAX_SPEECH_RETRIES = 2;
  const SPEECH_RETRY_DELAY_MS = 500;

  // クラウド音声は <audio> 要素を記事ごとに作り直さず、1つを使い回す。
  // 新しく作った要素の play() は「ユーザー操作の直後」でないとスマホの
  // ブラウザに拒否される。記事の切り替わりは /api/tts の取得待ちを挟むため
  // 操作直後ではなくなっており、毎回新しい要素を作っているとここで再生を
  // 拒否され、その記事が丸ごと飛ばされてしまう。一度再生できた要素は
  // 以降も再生を許可されるので、使い回すことでこれを防ぐ。
  let sharedAudio = null;

  function getSharedAudio() {
    if (!sharedAudio) {
      sharedAudio = new Audio();
      sharedAudio.preload = "auto";
    }
    return sharedAudio;
  }

  // 44バイトの無音WAV。再生ボタンを押した瞬間にこれを一度鳴らして
  // <audio> 要素を「解錠」しておく。
  const SILENT_AUDIO_SRC =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
  let audioUnlocked = false;

  function unlockAudioPlayback() {
    if (audioUnlocked || ttsMode !== "cloud") return;
    audioUnlocked = true;
    const audio = getSharedAudio();
    audio.src = SILENT_AUDIO_SRC;
    const played = audio.play();
    if (played && typeof played.catch === "function") played.catch(() => {});
  }

  async function speakOneCloudAttempt(text, token) {
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
      if (!res.ok) {
        // 429(レート制限)や5xx(サーバー側の一時的な問題)は再試行の価値がある。
        // 400番台(不正なリクエスト等)は再試行しても無駄なので諦める。
        return { ok: false, retryable: res.status === 429 || res.status >= 500 };
      }
      const blob = await res.blob();
      if (token !== playToken) return { ok: true }; // 取得中に停止/次の再生が始まった
      const objectUrl = URL.createObjectURL(blob);
      let playbackFailed = false;
      const audio = getSharedAudio();
      currentAudio = audio;
      await new Promise((resolve) => {
        const finish = () => {
          audio.onended = null;
          audio.onerror = null;
          stopCurrentAudio = null;
          resolve();
        };
        audio.onended = finish;
        audio.onerror = () => {
          playbackFailed = true;
          finish();
        };
        // stopAll() 等から強制停止されたときに、pause() だけでなく
        // このPromiseもきちんと解決させる(でないと待ち続けてBlob URLが
        // 解放されないまま残ってしまう)。この経路はエラーとして扱わない。
        stopCurrentAudio = () => {
          audio.pause();
          finish();
        };
        audio.src = objectUrl;
        audio.load();
        audio.play().catch((err) => {
          console.warn("[news-reader] 音声の再生が拒否されました:", err);
          playbackFailed = true;
          finish();
        });
      });
      URL.revokeObjectURL(objectUrl);
      currentAudio = null;
      if (token !== playToken) return { ok: true }; // 再生中に停止された
      return playbackFailed ? { ok: false, retryable: true } : { ok: true };
    } catch (err) {
      console.error("[news-reader] クラウド音声の取得に失敗しました:", err);
      return { ok: false, retryable: true };
    }
  }

  // 読み上げられたら true、再試行し尽くしても鳴らせなければ false を返す。
  // 自分で停止した場合は「失敗」ではないので true 扱いにする。
  async function speakOneCloud(text, token) {
    for (let attempt = 0; attempt <= MAX_SPEECH_RETRIES; attempt++) {
      if (token !== playToken) return true;
      const result = await speakOneCloudAttempt(text, token);
      if (result.ok) return true;
      if (!result.retryable) return false;
      console.warn(
        `[news-reader] クラウド音声の再生に失敗したため再試行します (${attempt + 1}/${MAX_SPEECH_RETRIES + 1})`
      );
      if (attempt < MAX_SPEECH_RETRIES) {
        await new Promise((r) => setTimeout(r, SPEECH_RETRY_DELAY_MS));
      }
    }
    return false;
  }

  // 自分で止めた(stopAll/次の再生の開始)ときのエラー。失敗ではない。
  const USER_STOP_SPEECH_ERRORS = new Set(["canceled", "interrupted"]);
  // 再試行しても結果が変わらないエラー。
  const NON_RETRYABLE_SPEECH_ERRORS = new Set(["canceled", "interrupted", "not-allowed"]);

  // 音声エンジンが発話をそのまま捨ててしまうことがある。このとき音は出ないのに
  // onend だけがほぼ即座に返ってくるため、成功として扱うと記事が丸ごと無音のまま
  // 次へ進んでしまう。読み上げが実際に始まれば必ず start が発火するので、
  // 「start が来ないまま一瞬で end だけ返ってきた」場合を捨てられたとみなす。
  // 単に速く読み終えただけの短い文を誤検知しないよう、start の有無・所要時間・
  // 文字数の3つが揃ったときだけ再試行する。
  const DROPPED_UTTERANCE_MS = 250;
  const DROP_CHECK_MIN_TEXT_LENGTH = 8;
  // onend も onerror も返ってこないまま止まってしまう端末があるので、
  // 想定所要時間を大きく超えたら打ち切って再試行する。
  // 日本語の読み上げをおおよそ毎秒7文字として見積もる。
  const SPEECH_CHARS_PER_SECOND = 7;
  const SPEECH_WATCHDOG_MARGIN_MS = 8000;
  // 無応答はエンジン側が止まっている可能性が高く、何度粘っても待ち時間が
  // 伸びるだけで固まったように見える。無応答での再試行は1回までにする。
  const MAX_SPEECH_TIMEOUT_RETRIES = 1;

  // 発話中のutteranceがガベージコレクションされると、読み上げが途中で
  // 打ち切られたりonendが返らなくなったりする。参照を保持して防ぐ。
  let activeUtterance = null;

  function estimateSpeechMs(text, rate) {
    return ((text.length / SPEECH_CHARS_PER_SECOND) * 1000) / (rate || 1);
  }

  function speakUtteranceOnce(text) {
    return new Promise((resolve) => {
      const rate = parseFloat(speedRange.value) || 1;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = (selectedVoice && selectedVoice.lang) || "ja-JP";
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = rate;
      utterance.pitch = parseFloat(pitchRange.value) || 1;
      activeUtterance = utterance;

      const queuedAt = Date.now();
      let settled = false;
      let timedOut = false;
      let started = false;

      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        activeUtterance = null;
        resolve(result);
      };

      const watchdog = setTimeout(() => {
        timedOut = true;
        synth.cancel(); // 詰まった発話を捨てないと次の発話も始まらない
        settle({ ok: false, error: "timeout" });
      }, estimateSpeechMs(text, rate) + SPEECH_WATCHDOG_MARGIN_MS);

      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => {
        const elapsed = Date.now() - queuedAt;
        const looksDropped =
          !started && text.length >= DROP_CHECK_MIN_TEXT_LENGTH && elapsed < DROPPED_UTTERANCE_MS;
        settle(looksDropped ? { ok: false, error: "dropped" } : { ok: true });
      };
      // watchdogのcancel()が誘発するcanceledで「自分で止めた」と誤判定しないよう、
      // タイムアウト経路のエラーはtimeoutとして扱う。
      utterance.onerror = (event) =>
        settle({ ok: false, error: timedOut ? "timeout" : event.error });

      synth.speak(utterance);
      // cancel()の直後などに一時停止状態のまま残る端末があり、そのままだと
      // 発話が始まらずタイムアウトするだけになる。念のため再開させる。
      if (synth.paused) synth.resume();
    });
  }

  // 読み上げられたら true、再試行し尽くしても鳴らせなければ false を返す。
  async function speakOneDevice(text, token) {
    if (!speechSupported) return false;
    const spokenText = spacesToComma(text);
    let timeouts = 0;
    for (let attempt = 0; attempt <= MAX_SPEECH_RETRIES; attempt++) {
      if (token !== playToken) return true;
      const result = await speakUtteranceOnce(spokenText);
      if (result.ok) return true;
      if (USER_STOP_SPEECH_ERRORS.has(result.error)) return true;
      if (NON_RETRYABLE_SPEECH_ERRORS.has(result.error)) return false;
      if (result.error === "timeout" && ++timeouts > MAX_SPEECH_TIMEOUT_RETRIES) return false;
      console.warn(
        `[news-reader] 読み上げに失敗したため再試行します (${attempt + 1}/${MAX_SPEECH_RETRIES + 1}): ${result.error}`
      );
      if (attempt < MAX_SPEECH_RETRIES) {
        await new Promise((r) => setTimeout(r, SPEECH_RETRY_DELAY_MS));
      }
    }
    return false;
  }

  function speakOne(text, token) {
    return ttsMode === "cloud" ? speakOneCloud(text, token) : speakOneDevice(text, token);
  }

  const PAUSE_BETWEEN_PARTS_MS = 250;
  // 記事の切り替わりでも必ず「間」を空ける。聞きやすさのためだけでなく、
  // 前の発話の終了イベントから抜けた新しいタスクで次を始めるために必要
  // (詳細は scheduleNextArticle のコメント)。
  const PAUSE_BETWEEN_ARTICLES_MS = 600;
  let playToken = 0;

  function ttsAvailable() {
    if (ttsMode === "cloud") return true;
    return speechSupported && japaneseVoices.length > 0;
  }

  // onend には「すべてのパートを実際に読み上げられたか」を渡す。
  async function speak(parts, token, { onend } = {}) {
    if (!ttsAvailable()) return;
    let spokenAll = true;
    for (let i = 0; i < parts.length; i++) {
      if (!(await speakOne(parts[i], token))) spokenAll = false;
      if (token !== playToken) return; // 途中で停止/次の再生が開始された
      if (i < parts.length - 1) {
        await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_PARTS_MS));
        if (token !== playToken) return;
      }
    }
    onend && onend(spokenAll);
  }

  // 読み上げ中の記事は色を変えるだけにして、画面は動かさない。
  // 勝手にスクロールすると、別の記事を読んでいる最中に位置を見失ううえ、
  // 操作ボタンから離れてしまう(ボタン側は .controls を画面上部に固定して
  // いつでも押せるようにしてある)。
  function highlightItem(index) {
    document.querySelectorAll(".news-item").forEach((el, i) => {
      el.classList.toggle("is-playing", i === index);
    });
  }

  // 再試行しても鳴らせなかった記事は、無言で次に進むと「勝手に飛ばされた」
  // としか見えない。一覧側に印を付けて、後から気づけるようにする。
  const failedArticleIndexes = new Set();

  function markArticleFailed(index) {
    failedArticleIndexes.add(index);
    const el = newsList.children[index];
    if (el) el.classList.add("is-failed");
    console.warn(`[news-reader] 記事 ${index + 1} の読み上げに失敗しました`);
  }

  function clearFailureMarks() {
    failedArticleIndexes.clear();
    newsList.querySelectorAll(".is-failed").forEach((el) => el.classList.remove("is-failed"));
  }

  // スマホは手を触れていないとすぐ画面が消灯し、その際にブラウザの処理
  // (読み上げ・タイマー・通信)が止められて「勝手にスキップされた」ように
  // 見えることがある。再生中は画面消灯を防ぐことでこれを軽減する。
  // 対応していないブラウザ(古いiOS Safari等)では何もしない。
  let wakeLock = null;

  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (err) {
      console.warn("[news-reader] Wake Lockを取得できませんでした:", err);
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // タブを一瞬離れる等でWake Lockが自動解除された場合、再生中であれば
  // 画面に戻ってきたタイミングで取り直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (isPlayingAll || isPlayingSingle) && !wakeLock) {
      acquireWakeLock();
    }
  });

  // 再生中の音声(端末合成/クラウド音声どちらも)を即座に止める。
  // synth.cancel() だけでなく stopCurrentAudio() も必ず呼ぶことで、
  // speakOneCloud内で待機しているPromiseを解決させ、ハングやBlob URL
  // リークを防ぐ。
  function interruptPlayback() {
    if (speechSupported) synth.cancel();
    if (stopCurrentAudio) stopCurrentAudio();
    currentAudio = null;
  }

  function stopAll() {
    playToken += 1; // 実行中の発話チェーンを無効化する
    interruptPlayback();
    releaseWakeLock();
    isPlayingAll = false;
    isPlayingSingle = false;
    playQueueIndex = -1;
    highlightItem(-1);
    playAllBtn.textContent = "▶ すべて読み上げる";
    stopBtn.disabled = true;
    setStatus(`${articles.length}件のニュースがあります`);
  }

  // 次の記事は、前の記事の終了イベントから抜けた「新しいタスク」で始める。
  // onend / ended ハンドラの中から続けて synth.speak() や audio.play() を呼ぶと、
  // 音声エンジンによっては次の発話がそのまま捨てられ、音が鳴らないのに終了だけが
  // 返ってくる。これが「記事の切り替わりで読み上げが飛ばされる」直接の原因になる。
  function scheduleNextArticle(token) {
    setTimeout(() => playNextInQueue(token), PAUSE_BETWEEN_ARTICLES_MS);
  }

  function playNextInQueue(token) {
    if (token !== playToken) return;
    playQueueIndex += 1;
    if (playQueueIndex >= articles.length) {
      finishPlayAll();
      return;
    }
    const index = playQueueIndex;
    highlightItem(index);
    setStatus(`読み上げ中: ${index + 1} / ${articles.length}`);
    speak(buildUtteranceParts(articles[index]), token, {
      onend: (spokenAll) => {
        if (!spokenAll) markArticleFailed(index);
        scheduleNextArticle(token);
      },
    });
  }

  function finishPlayAll() {
    const failedCount = failedArticleIndexes.size;
    stopAll();
    if (failedCount > 0) {
      setStatus(`読み上げが終わりました(${failedCount}件は音声を再生できませんでした)`);
    }
  }

  function startPlayAll() {
    if (!ttsAvailable()) {
      setStatus("お使いのブラウザは読み上げに対応していません");
      return;
    }
    if (articles.length === 0) return;
    playToken += 1;
    const token = playToken;
    interruptPlayback();
    unlockAudioPlayback(); // ボタンを押したこの場で <audio> 要素を解錠しておく
    clearFailureMarks();
    acquireWakeLock();
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
    interruptPlayback();
    unlockAudioPlayback(); // ボタンを押したこの場で <audio> 要素を解錠しておく
    acquireWakeLock();
    isPlayingAll = false;
    isPlayingSingle = true;
    highlightItem(index);
    stopBtn.disabled = false;
    setStatus(`読み上げ中: 記事 ${index + 1}`);
    speak(buildUtteranceParts(articles[index]), token, {
      onend: (spokenAll) => {
        if (!spokenAll) markArticleFailed(index);
        if (token !== playToken || !isPlayingSingle) return;
        stopAll();
        if (!spokenAll) setStatus("この記事の音声を再生できませんでした。もう一度お試しください。");
      },
    });
  }

  function buildThumbnail(article) {
    const url = window.ArticleImage.sanitizeImageUrl(article.imageUrl);
    if (!url) return null;
    const img = document.createElement("img");
    img.className = "news-thumb";
    img.src = url;
    img.alt = ""; // 見出しが隣にあるので、読み上げ環境では飾り扱いにする
    img.loading = "lazy";
    img.decoding = "async";
    // 直リンクをリファラで弾く配信元があるため、リファラを送らない
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      const item = img.closest(".news-item");
      if (item) item.classList.remove("has-thumb");
      img.remove();
    });
    return img;
  }

  function renderArticles() {
    newsList.innerHTML = "";
    articles.forEach((article, index) => {
      const li = document.createElement("li");
      li.className = "news-item";

      const top = document.createElement("div");
      top.className = "news-item-top";
      top.innerHTML = `<span>${article.source}</span><span>${formatDate(article.pubDate)}</span>`;

      // サムネイルは記事の識別を助けるだけの飾りなので、読み込めなければ
      // 枠ごと消す(空枠が残る方が見た目に悪い)。読み上げ内容には影響しない。
      const thumb = buildThumbnail(article);

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
      if (thumb) {
        li.classList.add("has-thumb");
        li.append(thumb);
      }
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
      imageUrl: window.ArticleImage.extractImageUrlFromXml(item),
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
      if (articles.length > 0) {
        setStatus(`${articles.length}件のニュースがあります`);
      } else if (typeof data.sourcesOk === "number" && data.sourcesOk === 0) {
        // サーバーは200を返すが、取得元RSSが全滅していた場合。
        // 「本当に該当ニュースが無い」場合と区別できるようエラー表示にする
        setStatus("ニュースの取得に失敗しました。時間をおいて再度お試しください。");
      } else {
        setStatus("現在表示できるニュースがありません。しばらくしてから更新してみてください。");
      }
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
      const voice = cloudVoices.find((v) => v.name === voiceSelect.value);
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
    interruptPlayback();
    unlockAudioPlayback();
    speak(["これはテスト再生です。ニュースはこのような声で読み上げられます。"], playToken);
  });

  loadNews();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
