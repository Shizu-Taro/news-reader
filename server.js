const path = require("path");
const express = require("express");
const Parser = require("rss-parser");
const { isCrimeArticle } = require("./public/newsFilter.js");

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分キャッシュ
const MAX_ARTICLES = 40;

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

const app = express();
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

app.listen(PORT, () => {
  console.log(`[news-reader] http://localhost:${PORT} で起動しました`);
});
