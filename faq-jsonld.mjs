/* FAQ構造化データ（JSON-LD）＆Markdown ジェネレーター（faq_jsonld_generate）
 * 質問と回答のペアから、schema.org の FAQPage 形式の JSON-LD・同じ内容の Markdown・
 * 貼り付け用の HTML（details/summary）を同時に作る。
 * 変換のコア（parseAnswer / build / parseBulk ほか）は FirstCHTools の site/faq-jsonld/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 既存の jsonld_generate（type=faqpage）は質問と回答をそのまま文字列で入れるだけ。こちらは回答を
 * 「空行で段落・改行・[文字](URL) と裸のURLはリンク・行頭の - ・ 1. は箇条書き」として読んで HTML にし、
 * Markdown と details/summary の HTML も同時に返し、「Q: / A:」「## 見出し」形式の一括貼り付けも解析する。
 * 完全ローカル処理・ネットワーク送信なし。 */

// 件数と文字数の上限（site の LIMITS と同じ値。site では入力欄の maxlength と行数の上限）
export const LIMITS = { rows: 200, q: 500, a: 5000 };

/* ==================== ここから変換のコア ==================== */

// リンクにしてよい宛先。javascript: などはリンクにせず文字のまま残す
export const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;
export const ABS_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
// [文字](URL) か、裸の http(s) URL。URL に使える文字は ASCII に限る（「https://example.com/です」の「です」を含めない）
export const INLINE_RE = /\[([^\[\]\n]+)\]\(\s*<?([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*)>?\s*\)|(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)/g;
export const BULLET_RE = /^[ \t\u3000]*(?:[-*•]\s+|・\s*)(.*\S.*)$/;
export const ORDERED_RE = /^[ \t\u3000]*(\d{1,3})(?:[.)]\s+|[．）]\s*)(.*\S.*)$/;

export const nl = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');

/** 裸のURLの末尾に付いた句読点や、対になっていない閉じ括弧を外す */
export function trimUrl(u) {
  let s = u;
  for (;;) {
    const last = s.slice(-1);
    if (/[.,;:!?'"*]/.test(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) { s = s.slice(0, -1); continue; }
    if (last === ']' && (s.match(/\[/g) || []).length < (s.match(/\]/g) || []).length) { s = s.slice(0, -1); continue; }
    return s;
  }
}

/** 1行を文字とリンクに分ける。flags に使えないリンク・相対リンクの有無を記録する */
export function inlineTokens(line, flags) {
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  const pushText = (v) => { if (!v) return; if (out.length && out[out.length - 1].t === 'text') out[out.length - 1].v += v; else out.push({ t: 'text', v }); };
  while ((m = INLINE_RE.exec(line))) {
    if (m[3]) {
      const url = trimUrl(m[3]);
      pushText(line.slice(last, m.index));
      out.push({ t: 'link', text: url, href: url, bare: true });
      last = m.index + url.length;
      INLINE_RE.lastIndex = last;
      continue;
    }
    pushText(line.slice(last, m.index));
    const href = m[2];
    const text = m[1].trim();
    if (href && SAFE_HREF.test(href) && text) {
      out.push({ t: 'link', text, href, bare: false });
      if (!ABS_HREF.test(href)) flags.rel = true;
    } else {
      pushText(m[0]);
      flags.bad = true;
    }
    last = m.index + m[0].length;
  }
  pushText(line.slice(last));
  return out;
}

/** 回答の文字列を段落・箇条書きのかたまりに分ける */
export function parseAnswer(src) {
  const flags = { rel: false, bad: false };
  const blocks = [];
  let cur = null;
  for (const raw of nl(src).split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (!line.trim()) { cur = null; continue; }
    let mb = BULLET_RE.exec(line);
    let mo = mb ? null : ORDERED_RE.exec(line);
    if (mb || mo) {
      const type = mb ? 'ul' : 'ol';
      const body = (mb ? mb[1] : mo[2]).trim();
      if (!cur || cur.type !== type) {
        cur = { type, items: [] };
        if (mo) cur.start = Number(mo[1]);
        blocks.push(cur);
      }
      cur.items.push(inlineTokens(body, flags));
      continue;
    }
    if (!cur || cur.type !== 'p') { cur = { type: 'p', lines: [] }; blocks.push(cur); }
    cur.lines.push(inlineTokens(line.replace(/^[ \t]+/, ''), flags));
  }
  return { blocks, flags };
}

/* ---------- HTML ---------- */
// 本文の中では & < > だけを実体参照にする（日本語の引用符「」“”や全角記号はそのまま残す）
export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');
export const htmlInline = (toks) => toks.map((k) => (k.t === 'text' ? escHtml(k.v) : '<a href="' + escAttr(k.href) + '">' + escHtml(k.text) + '</a>')).join('');

export function htmlBlocks(blocks, indent) {
  const pad = indent || '';
  return blocks.map((b) => {
    if (b.type === 'p') return pad + '<p>' + b.lines.map(htmlInline).join('<br>') + '</p>';
    const open = b.type === 'ol' && b.start && b.start !== 1 ? '<ol start="' + b.start + '">' : '<' + b.type + '>';
    return pad + open + b.items.map((it) => '<li>' + htmlInline(it) + '</li>').join('') + '</' + b.type + '>';
  });
}

/** JSON-LD の acceptedAnswer.text に入れる HTML。1行だけの文章は <p> で包まない */
export function answerHtml(blocks) {
  if (blocks.length === 1 && blocks[0].type === 'p' && blocks[0].lines.length === 1) return htmlInline(blocks[0].lines[0]);
  return htmlBlocks(blocks).join('');
}

/** JSON-LD をプレーンテキストで書くとき。リンクは「文字（URL）」、箇条書きは記号を付けた行にする */
export function answerText(blocks, lang) {
  const inl = (toks) => toks.map((k) => {
    if (k.t === 'text') return k.v;
    if (k.bare || k.text === k.href) return k.href;
    return lang === 'en' ? k.text + ' (' + k.href + ')' : k.text + '（' + k.href + '）';
  }).join('');
  return blocks.map((b) => {
    if (b.type === 'p') return b.lines.map(inl).join('\n');
    return b.items.map((it, i) => (b.type === 'ul' ? (lang === 'en' ? '- ' : '・') : (b.start || 1) + i + '. ') + inl(it)).join('\n');
  }).join('\n\n');
}

/* ---------- Markdown ---------- */
export function mdEscape(s) {
  return String(s)
    .replace(/([\\`*_[\]<>~|])/g, '\\$1')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}
// 行頭で見出し・引用・箇条書き・番号付きリストと読まれる文字を逃がす
export const mdLineStart = (s) => s.replace(/^(\s*)([#>+=-])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2');
export function mdDest(href) {
  return /[\s()<>]/.test(href) ? '<' + href.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20') + '>' : href;
}
export function mdInline(toks) {
  return toks.map((k, i) => {
    if (k.t === 'text') return i === 0 ? mdLineStart(mdEscape(k.v)) : mdEscape(k.v);
    if (k.bare) return '<' + k.href + '>';
    return '[' + mdEscape(k.text) + '](' + mdDest(k.href) + ')';
  }).join('');
}
export function mdBlocks(blocks) {
  return blocks.map((b) => {
    // 段落の中の改行は CommonMark のハードブレーク（行末の \）にする。行末の空白2つは編集中に消えやすいため使わない
    if (b.type === 'p') return b.lines.map(mdInline).join('\\\n');
    return b.items.map((it, i) => (b.type === 'ul' ? '- ' : (b.start || 1) + i + '. ') + mdInline(it)).join('\n');
  }).join('\n\n');
}
export function mdHeading(level, text) {
  const body = mdLineStart(mdEscape(text)).replace(/(\s)(#+)\s*$/, '$1\\$2');
  return '#'.repeat(level) + ' ' + body;
}

/** <script> の中に置いても途切れない JSON。</script と <!-- を逃がし、U+2028/2029 も念のためエスケープする */
export function safeJson(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '\\u003c!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 入力の行を整える。質問は1行に、空の行は数えて外す */
export function cleanItems(items) {
  const out = [];
  let skipped = 0;
  for (const it of items || []) {
    const q = nl(it && it.q).replace(/\s*\n\s*/g, ' ').trim();
    const a = nl(it && it.a).replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!q && !a.trim()) continue;
    if (!q || !a.trim()) { skipped++; continue; }
    out.push({ q, a });
  }
  return { items: out, skipped };
}

/**
 * 3つの形式を作る。
 * opts: { title, level(2|3), answerFormat('html'|'text'), wrapScript, exclusive, lang }
 */
export function build(rawItems, opts) {
  const o = Object.assign({ title: '', level: 3, answerFormat: 'html', wrapScript: true, exclusive: false, lang: 'ja' }, opts || {});
  const level = o.level === 2 ? 2 : 3;
  const { items, skipped } = cleanItems(rawItems);
  const title = nl(o.title).replace(/\s*\n\s*/g, ' ').trim();
  const warnings = [];
  if (skipped) warnings.push({ k: 'skipped', n: skipped });
  const seen = new Map();
  const dups = [];
  let rel = 0;
  let bad = 0;
  const parsed = items.map((it, i) => {
    const key = it.q.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) dups.push(i + 1); else seen.set(key, i + 1);
    const p = parseAnswer(it.a);
    if (p.flags.rel) rel++;
    if (p.flags.bad) bad++;
    return { q: it.q, blocks: p.blocks };
  });
  if (dups.length) warnings.push({ k: 'dup', list: dups });
  if (bad) warnings.push({ k: 'bad', n: bad });
  if (rel) warnings.push({ k: 'rel', n: rel });
  if (!parsed.length) warnings.push({ k: 'none' });

  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: parsed.map((p) => ({
      '@type': 'Question',
      name: p.q,
      acceptedAnswer: { '@type': 'Answer', text: o.answerFormat === 'text' ? answerText(p.blocks, o.lang) : answerHtml(p.blocks) },
    })),
  };
  const json = safeJson(data);
  const jsonld = o.wrapScript ? '<script type="application/ld+json">\n' + json + '\n</script>' : json;

  const md = [];
  if (title) md.push(mdHeading(level - 1, title));
  for (const p of parsed) md.push(mdHeading(level, p.q), mdBlocks(p.blocks));
  const markdown = md.length ? md.join('\n\n') + '\n' : '';

  const h = ['<section class="faq">'];
  if (title) h.push('  <h' + (level - 1) + '>' + escHtml(title) + '</h' + (level - 1) + '>');
  for (const p of parsed) {
    h.push('  <details' + (o.exclusive ? ' name="faq"' : '') + '>');
    h.push('    <summary>' + escHtml(p.q) + '</summary>');
    h.push('    <div class="faq-answer">');
    h.push(...htmlBlocks(p.blocks, '      '));
    h.push('    </div>');
    h.push('  </details>');
  }
  h.push('</section>');
  const html = parsed.length ? h.join('\n') + '\n' : '';

  return { jsonld, json, data, markdown, html, warnings, count: parsed.length };
}

/**
 * まとめて貼り付けた文章を質問と回答に分ける。
 * 「Q: / Q1. / Ｑ． / 質問：」で始まる行を質問、「A: / Ａ． / 回答：/ 答え：」で始まる行を回答の始まりとし、
 * Markdown の見出し（## …）も質問として読む。回答の次の行からは次の質問までを回答に含める。
 */
// 未追加分を原文のまま残せるよう、質問の開始位置も記録する。
export function parseBulkEntries(text) {
  const Q_RE = /^\s*(?:[QＱqｑ]\s*[0-9０-９]*\s*[.:：．、)）]|質問\s*[0-9０-９]*\s*[:：．.、)）]|問\s*[0-9０-９]+\s*[:：．.、)）]?)\s*(.*)$/;
  const A_RE = /^\s*(?:[AＡaａ]\s*[0-9０-９]*\s*[.:：．、)）]|(?:回答|答え|答)\s*[0-9０-９]*\s*[:：．.、)）])\s*(.*)$/;
  const H_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
  const out = [];
  let cur = null;
  let inAnswer = false;
  const lines = String(text == null ? '' : text).split(/(\r\n|\r|\n)/);
  let offset = 0;
  const finish = () => {
    if (!cur) return;
    cur.a = cur.a.replace(/^\n+|\s+$/g, '');
    if (cur.q.trim() && (cur.a || !cur.heading)) out.push({ item: { q: cur.q.trim(), a: cur.a }, start: cur.start });
    cur = null;
  };
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const start = offset;
    offset += line.length + (lines[i + 1] || '').length;
    const mq = Q_RE.exec(line);
    const mh = mq ? null : H_RE.exec(line);
    if (mq || mh) {
      finish();
      let q = (mq ? mq[1] : mh[1]);
      // 見出しの中の「Q.」も外す
      const inner = Q_RE.exec(q);
      if (inner) q = inner[1];
      cur = { q, a: '', heading: !!mh, start };
      inAnswer = false;
      continue;
    }
    const ma = A_RE.exec(line);
    if (ma && cur && !inAnswer) { cur.a = ma[1]; inAnswer = true; continue; }
    if (!cur) continue;
    if (!inAnswer) {
      if (!line.trim()) continue;
      if (cur.heading) { inAnswer = true; cur.a = line; continue; }
      // 質問の続きの行（回答の印が来るまで）
      cur.q += ' ' + line.trim();
      continue;
    }
    cur.a += '\n' + line;
  }
  finish();
  return out;
}

export function parseBulk(text) {
  return parseBulkEntries(text).map((entry) => entry.item);
}

export const safeFileName = (s, fallback) => {
  const x = String(s || '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60);
  return x || fallback;
};

/* ==================== ここまで変換のコア ==================== */

/* ==================== ここから MCP 側だけ（ツールの入出力） ==================== */

// 警告の文言（site の T.warn と同じ文）
const WARN_TEXT = {
  ja: {
    skipped: (w) => '質問か回答の片方が空の行が' + w.n + '件あります。出力には含めていません。',
    dup: (w) => '同じ質問が重複しています（' + w.list.join('・') + '件目）。',
    bad: (w) => 'リンクにできない宛先（javascript: など）が' + w.n + '件の回答にあります。リンクにせず文字のまま出力しています。',
    rel: (w) => '相対URL（/ や # で始まるリンク）が' + w.n + '件の回答にあります。JSON-LD はページの外で読まれることがあるので、https:// から始まるURLにするのが確実です。',
    none: () => '質問と回答の両方を入れると、ここに出力されます。',
  },
  en: {
    skipped: (w) => w.n + ' row' + (w.n === 1 ? ' has' : 's have') + ' only a question or only an answer and ' + (w.n === 1 ? 'is' : 'are') + ' left out.',
    dup: (w) => 'Duplicate question (no. ' + w.list.join(', ') + ').',
    bad: (w) => w.n + ' answer' + (w.n === 1 ? ' has' : 's have') + ' a link target that cannot be used (such as javascript:). It is kept as plain text.',
    rel: (w) => w.n + ' answer' + (w.n === 1 ? ' uses' : 's use') + ' a relative link (starting with / or #). JSON-LD may be read outside the page, so a full https:// URL is safer.',
    none: () => 'Enter both a question and an answer to see the output.',
  },
};
const WARN_CODE = { skipped: 'SKIPPED', dup: 'DUPLICATE', bad: 'UNSAFE_LINK', rel: 'RELATIVE_LINK', none: 'EMPTY' };

export class FaqJsonldToolError extends Error {}

/**
 * FAQ の JSON-LD・Markdown・HTML を作る。
 * @param {object} opts
 * @param {{q:string, a:string}[]} [opts.items] 質問と回答（200件まで・質問500字・回答5000字まで）
 * @param {string} [opts.bulk] 「Q: / A:」や「## 見出し」で書いたまとめての文章。items の後ろへ足す
 * @param {string} [opts.title] 見出し（Markdown・HTML の先頭に level-1 の見出しで入る）
 * @param {2|3} [opts.level=3] 質問の見出しの段（2 なら ##、3 なら ###）
 * @param {'html'|'text'} [opts.answer_format='html'] JSON-LD の acceptedAnswer.text の書き方
 * @param {boolean} [opts.wrap_script=true] JSON-LD を <script type="application/ld+json"> で包む
 * @param {boolean} [opts.exclusive=false] details に name="faq" を付け、1つ開くとほかが閉じるようにする
 * @param {'ja'|'en'} [opts.lang='ja'] 警告の言語と、answer_format=text のときのリンク・箇条書きの書き方
 */
export async function faqJsonldTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new FaqJsonldToolError(`lang は ja か en: ${opts.lang}`);
  const level = opts.level === undefined ? 3 : opts.level;
  if (level !== 2 && level !== 3) throw new FaqJsonldToolError(`level は 2 か 3: ${opts.level}`);
  const answerFormat = opts.answer_format === undefined ? 'html' : opts.answer_format;
  if (answerFormat !== 'html' && answerFormat !== 'text') throw new FaqJsonldToolError(`answer_format は html か text: ${opts.answer_format}`);
  if (opts.items === undefined && opts.bulk === undefined) throw new FaqJsonldToolError('items か bulk を渡してください');
  if (opts.items !== undefined && !Array.isArray(opts.items)) throw new FaqJsonldToolError('items は {q, a} の配列で渡してください');
  if (opts.bulk !== undefined && typeof opts.bulk !== 'string') throw new FaqJsonldToolError('bulk は文字列で渡してください');

  const items = [];
  (opts.items || []).forEach((it, i) => {
    const q = it && it.q != null ? String(it.q) : '';
    const a = it && it.a != null ? String(it.a) : '';
    if ([...q].length > LIMITS.q) throw new FaqJsonldToolError(`items[${i}].q は ${LIMITS.q} 文字まで`);
    if ([...a].length > LIMITS.a) throw new FaqJsonldToolError(`items[${i}].a は ${LIMITS.a} 文字まで`);
    items.push({ q, a });
  });
  let fromBulk = 0;
  if (opts.bulk !== undefined) {
    const parsed = parseBulk(opts.bulk);
    if (!parsed.length) {
      throw new FaqJsonldToolError('bulk から質問を読み取れませんでした。「Q:」「A:」で始まる行か、「## 」の見出しで質問を書いてください');
    }
    fromBulk = parsed.length;
    items.push(...parsed);
  }
  if (items.length > LIMITS.rows) throw new FaqJsonldToolError(`質問は ${LIMITS.rows} 件まで: ${items.length}`);

  const r = build(items, {
    title: opts.title == null ? '' : String(opts.title),
    level,
    answerFormat,
    wrapScript: opts.wrap_script !== false,
    exclusive: opts.exclusive === true,
    lang,
  });
  return {
    count: r.count,
    ...(opts.bulk !== undefined ? { parsed_from_bulk: fromBulk } : {}),
    // site と同じく、質問が1件も無いときは JSON-LD を出さない
    jsonld: r.count ? r.jsonld : '',
    data: r.data,
    markdown: r.markdown,
    html: r.html,
    warnings: r.warnings.map((w) => ({
      code: WARN_CODE[w.k],
      message: WARN_TEXT[lang][w.k](w),
      ...(w.n !== undefined ? { count: w.n } : {}),
      ...(w.list ? { items: w.list } : {}),
    })),
  };
}
