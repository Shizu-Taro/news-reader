require("dotenv").config();

const path = require("path");
const express = require("express");
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

let cache = { fetchedAt: 0, articles: [] };

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
    return (parsed.items || []).map((item) => {
      const summary = stripHtml(item.contentSnippet || item.content || item.summary || "");
      return {
        title: (item.title || "").trim(),
        link: item.link || "",
        source: feed.source,
        pubDate: item.pubDate || item.isoDate || null,
        summary,
      };
    });
  } catch (err) {
    console.error(`[news-reader] "${feed.source}" の取得に失敗しました: ${err.message}`);
    return [];
  }
}

async function fetchAllNews() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const merged = results.flat();

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

  return filtered.slice(0, MAX_ARTICLES);
}

async function getNews({ forceRefresh = false } = {}) {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (forceRefresh || isStale || cache.articles.length === 0) {
    const articles = await fetchAllNews();
    cache = { fetchedAt: Date.now(), articles };
  }
  return cache;
}

// Google Cloud Text-to-Speech で使えるボイス名のみ許可する(任意の文字列を
// 外部APIにそのまま渡さないための簡易チェック)
const ALLOWED_TTS_VOICES = new Set([
  "ja-JP-Neural2-B",
  "ja-JP-Neural2-C",
  "ja-JP-Neural2-D",
  "ja-JP-Wavenet-A",
  "ja-JP-Wavenet-B",
  "ja-JP-Wavenet-C",
  "ja-JP-Wavenet-D",
]);
const DEFAULT_TTS_VOICE = "ja-JP-Neural2-B";

const ttsCache = new Map();

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// スペース(半角・全角)を句読点の「、」と同じ読み方にするため、
// 送信前にテキスト側で置き換えてしまう
function spacesToComma(text) {
  return text.replace(/[ 　]+/g, "、");
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

app.get("/api/news", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1";
    const { fetchedAt, articles } = await getNews({ forceRefresh });
    res.json({ updatedAt: new Date(fetchedAt).toISOString(), count: articles.length, articles });
  } catch (err) {
    console.error("[news-reader] /api/news エラー:", err);
    res.status(500).json({ error: "ニュースの取得に失敗しました" });
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

  const voiceName = ALLOWED_TTS_VOICES.has(req.body?.voiceName)
    ? req.body.voiceName
    : DEFAULT_TTS_VOICE;
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
