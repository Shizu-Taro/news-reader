require("dotenv").config();

const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Parser = require("rss-parser");
const { isCrimeArticle } = require("./public/newsFilter.js");

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分キャッシュ
const MAX_ARTICLES = 40;
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || "";
const TTS_CACHE_MAX_ENTRIES = 200;

// 複数のRSSフィードを組み合わせて取得する
const FEEDS = [
  { url: "https://www3.nhk.or.jp/rss/news/cat0.xml", source: "NHKニュース" },
  { url: "https://news.yahoo.co.jp/rss/topics/top-picks.xml", source: "Yahoo!ニュース" },
  { url: "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja", source: "Googleニュース" },
];

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsReaderBot/1.0)" },
});

let cache = { fetchedAt: 0, articles: [], sourcesOk: 0, sourcesTotal: FEEDS.length };

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function normalizeTitle(title) {
  return (title || "").trim().toLowerCase();
}

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = (parsed.items || []).map((item) => {
      const summary = stripHtml(item.contentSnippet || item.content || item.summary || "");
      return {
        title: (item.title || "").trim(),
        link: item.link || "",
        source: feed.source,
        pubDate: item.pubDate || item.isoDate || null,
        summary,
      };
    });
    return { ok: true, items };
  } catch (err) {
    console.error(`[news-reader] "${feed.source}" の取得に失敗しました: ${err.message}`);
    return { ok: false, items: [] };
  }
}

async function fetchAllNews() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const sourcesOk = results.filter((r) => r.ok).length;
  const merged = results.flatMap((r) => r.items);

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
    (article) => !isCrimeArticle(article.title) && !isCrimeArticle(article.summary)
  );

  filtered.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const dateB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return dateB - dateA;
  });

  return { articles: filtered.slice(0, MAX_ARTICLES), sourcesOk, sourcesTotal: FEEDS.length };
}

async function getNews({ forceRefresh = false } = {}) {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (forceRefresh || isStale || cache.articles.length === 0) {
    const { articles, sourcesOk, sourcesTotal } = await fetchAllNews();
    cache = { fetchedAt: Date.now(), articles, sourcesOk, sourcesTotal };
  }
  return cache;
}

// Google Cloud Text-to-Speech の日本語ボイス一覧は、ハードコードせずAPIに
// 都度問い合わせる(Chirp3-HDなど新しい声が追加されても自動的に使えるように)。
// キーが有効でも一覧取得に失敗した場合の最後の砦として、動作確認済みの
// ボイス名だけは静的にも保持しておく。
const FALLBACK_TTS_VOICES = new Set([
  "ja-JP-Neural2-B",
  "ja-JP-Neural2-C",
  "ja-JP-Neural2-D",
  "ja-JP-Wavenet-A",
  "ja-JP-Wavenet-B",
  "ja-JP-Wavenet-C",
  "ja-JP-Wavenet-D",
]);
const DEFAULT_TTS_VOICE = "ja-JP-Neural2-B";
const VOICE_LIST_TTL_MS = 60 * 60 * 1000; // 1時間キャッシュ(声の一覧は頻繁には変わらない)

let voiceListCache = { fetchedAt: 0, voices: [] };

async function fetchAvailableVoices() {
  if (
    voiceListCache.voices.length > 0 &&
    Date.now() - voiceListCache.fetchedAt < VOICE_LIST_TTL_MS
  ) {
    return voiceListCache.voices;
  }

  const url = `https://texttospeech.googleapis.com/v1/voices?languageCode=ja-JP&key=${GOOGLE_TTS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`List voices failed ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const voices = (data.voices || [])
    .filter((v) => Array.isArray(v.languageCodes) && v.languageCodes.includes("ja-JP"))
    .map((v) => ({ name: v.name, gender: v.ssmlGender }));

  voiceListCache = { fetchedAt: Date.now(), voices };
  return voices;
}

const ttsCache = new Map();

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// スペース(半角・全角)を句読点の「、」と同じ読み方にするため、
// 送信前にテキスト側で置き換えてしまう。ただし英単語同士の間のスペース
// (例: "Machine Learning")は、そのまま読ませたいので変換しない。
const SPACE_PLACEHOLDER = String.fromCharCode(0xe000);

function spacesToComma(text) {
  const protectedText = text.replace(/(?<=[A-Za-z])[ 　]+(?=[A-Za-z])/g, SPACE_PLACEHOLDER);
  const converted = protectedText.replace(/[ 　]+/g, "、");
  return converted.split(SPACE_PLACEHOLDER).join(" ");
}

async function synthesizeSpeech({ text, voiceName, speakingRate, pitch }) {
  const cacheKey = JSON.stringify({ text, voiceName, speakingRate, pitch });
  const cached = ttsCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: spacesToComma(text) },
      voice: { languageCode: "ja-JP", name: voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate, pitch },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Google TTS API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const audioBuffer = Buffer.from(data.audioContent, "base64");

  if (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
    ttsCache.delete(ttsCache.keys().next().value);
  }
  ttsCache.set(cacheKey, audioBuffer);

  return audioBuffer;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// /api/tts は課金対象のGoogle Cloud APIを呼び出すため、
// 連打・悪用による意図しない課金増加を防ぐレート制限をかけておく
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "リクエストが多すぎます。しばらくしてから再試行してください。" },
});
app.use("/api/tts", ttsLimiter);

app.get("/api/news", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1";
    const { fetchedAt, articles, sourcesOk, sourcesTotal } = await getNews({ forceRefresh });
    res.json({
      updatedAt: new Date(fetchedAt).toISOString(),
      count: articles.length,
      articles,
      sourcesOk,
      sourcesTotal,
    });
  } catch (err) {
    console.error("[news-reader] /api/news エラー:", err);
    res.status(500).json({ error: "ニュースの取得に失敗しました" });
  }
});

app.get("/api/tts/voices", async (req, res) => {
  if (!GOOGLE_TTS_API_KEY) {
    res.status(501).json({ error: "GOOGLE_TTS_API_KEY が設定されていません" });
    return;
  }
  try {
    const voices = await fetchAvailableVoices();
    res.json({ voices });
  } catch (err) {
    console.error("[news-reader] /api/tts/voices エラー:", err);
    res.status(502).json({ error: "音声一覧の取得に失敗しました" });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!GOOGLE_TTS_API_KEY) {
    res.status(501).json({ error: "GOOGLE_TTS_API_KEY が設定されていません" });
    return;
  }

  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 2000) : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text が空です" });
    return;
  }

  const requestedVoice = req.body?.voiceName;
  let voiceName = DEFAULT_TTS_VOICE;
  try {
    const voices = await fetchAvailableVoices();
    const names = new Set(voices.map((v) => v.name));
    if (names.has(requestedVoice)) {
      voiceName = requestedVoice;
    } else if (voices.length > 0) {
      voiceName = voices[0].name;
    }
  } catch (err) {
    console.error("[news-reader] 音声一覧の取得に失敗したためフォールバックします:", err);
    if (FALLBACK_TTS_VOICES.has(requestedVoice)) voiceName = requestedVoice;
  }

  const speakingRate = clamp(req.body?.speakingRate, 0.5, 2.0, 1.0);
  const pitch = clamp(req.body?.pitch, -10, 10, 0);

  try {
    const audioBuffer = await synthesizeSpeech({ text, voiceName, speakingRate, pitch });
    res.set("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    console.error("[news-reader] /api/tts エラー:", err);
    res.status(502).json({ error: "音声合成に失敗しました" });
  }
});

app.listen(PORT, () => {
  console.log(`[news-reader] http://localhost:${PORT} で起動しました`);
});
