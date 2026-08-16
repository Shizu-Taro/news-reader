// Node (require) とブラウザ (<script>) の両方から使える共有モジュール
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ArticleImage = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // RSSでは画像の入る場所がフィードごとにバラバラなので、代表的な形式を
  // 順に探して最初に見つかったものを使う。どれも無ければ画像なしとして扱う。
  //
  //   1. <enclosure url="..." type="image/jpeg">
  //   2. <media:thumbnail url="...">
  //   3. <media:content url="..." medium="image">
  //   4. <content:encoded> や <description> の中の最初の <img src="...">

  // 画像URLとして受け付けてよいものだけを通す。
  // http: のままではHTTPSページから読むと混在コンテンツでブロックされるが、
  // 配信元はたいていHTTPSでも同じ画像を返すので、捨てずにhttps:へ読み替える。
  // 読み替えた先が無ければ表示側の onerror で枠ごと消えるだけなので実害はない。
  // data: や javascript: は受け付けない。
  function sanitizeImageUrl(url) {
    if (typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    // プロトコル相対 (//example.com/a.jpg)
    if (trimmed.startsWith("//")) return `https:${trimmed}`;
    if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, "https://");
    if (!/^https:\/\//i.test(trimmed)) return null;
    return trimmed;
  }

  function isImageType(type) {
    return typeof type === "string" && type.toLowerCase().startsWith("image/");
  }

  // HTML文字列の中から最初の <img src="..."> を取り出す。
  // サーバー側にはDOMパーサが無いため、stripHtml と同じく正規表現で処理する。
  function firstImgSrcFromHtml(html) {
    if (typeof html !== "string" || !html) return null;
    const match = html.match(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    return match ? match[1] : null;
  }

  // media:thumbnail や media:content が複数ある場合は、幅の大きいものを選ぶ。
  // サムネイル用途でも、極端に小さい画像だと粗く見えるため。
  function pickLargest(candidates) {
    let best = null;
    let bestWidth = -1;
    for (const candidate of candidates) {
      const url = sanitizeImageUrl(candidate.url);
      if (!url) continue;
      const width = parseInt(candidate.width, 10);
      const score = Number.isFinite(width) ? width : 0;
      if (score > bestWidth) {
        best = url;
        bestWidth = score;
      }
    }
    return best;
  }

  function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  // rss-parser が返すitemオブジェクトから画像URLを取り出す(サーバー側)。
  // media:* を拾うには Parser 生成時の customFields.item への登録が必要。
  function extractImageUrl(item) {
    if (!item) return null;

    const enclosure = item.enclosure;
    if (enclosure && (isImageType(enclosure.type) || !enclosure.type)) {
      const url = sanitizeImageUrl(enclosure.url);
      if (url) return url;
    }

    // customFields で登録すると { $: { url, width } } の形で入ってくる
    const mediaCandidates = [];
    for (const key of ["mediaThumbnail", "mediaContent"]) {
      for (const entry of toArray(item[key])) {
        const attrs = (entry && entry.$) || entry || {};
        if (attrs.medium && attrs.medium !== "image") continue;
        if (attrs.type && !isImageType(attrs.type)) continue;
        mediaCandidates.push({ url: attrs.url, width: attrs.width });
      }
    }
    const fromMedia = pickLargest(mediaCandidates);
    if (fromMedia) return fromMedia;

    for (const html of [item.contentEncoded, item.content, item["content:encoded"]]) {
      const src = sanitizeImageUrl(firstImgSrcFromHtml(html));
      if (src) return src;
    }

    return null;
  }

  // ブラウザ単体モードでCORSプロキシ経由に取得したXMLの<item>要素から取り出す。
  // extractImageUrl と同じ優先順位・同じ判定になるようにしてある。
  function extractImageUrlFromXml(itemElement) {
    if (!itemElement) return null;
    const attr = (el, name) => (el && el.getAttribute(name)) || "";

    for (const enclosure of itemElement.getElementsByTagName("enclosure")) {
      const type = attr(enclosure, "type");
      if (type && !isImageType(type)) continue;
      const url = sanitizeImageUrl(attr(enclosure, "url"));
      if (url) return url;
    }

    const mediaCandidates = [];
    for (const tag of ["thumbnail", "content"]) {
      // getElementsByTagNameNS が使えないパーサもあるため、名前空間なしでも拾う
      const nodes = [
        ...itemElement.getElementsByTagName(`media:${tag}`),
        ...itemElement.getElementsByTagName(tag),
      ];
      for (const node of nodes) {
        const medium = attr(node, "medium");
        const type = attr(node, "type");
        if (medium && medium !== "image") continue;
        if (type && !isImageType(type)) continue;
        mediaCandidates.push({ url: attr(node, "url"), width: attr(node, "width") });
      }
    }
    const fromMedia = pickLargest(mediaCandidates);
    if (fromMedia) return fromMedia;

    for (const tag of ["content:encoded", "encoded", "description"]) {
      for (const node of itemElement.getElementsByTagName(tag)) {
        const src = sanitizeImageUrl(firstImgSrcFromHtml(node.textContent || ""));
        if (src) return src;
      }
    }

    return null;
  }

  return { sanitizeImageUrl, firstImgSrcFromHtml, extractImageUrl, extractImageUrlFromXml };
});
