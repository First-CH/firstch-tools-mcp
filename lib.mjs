// First CH Tools — 計算ロジック（site/ 各ツールのJSと同一アルゴリズム）
// site側を変更したらこちらも同期すること（正本はこのファイルとsite側の2重管理を避けるため、
// アルゴリズム変更時は必ず両方を1コミットで更新する）。

export function parseHex(s) {
  s = String(s).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.1 コントラスト比とAA/AAA判定 */
export function contrastCheck(fg, bg) {
  const c1 = parseHex(fg);
  const c2 = parseHex(bg);
  if (!c1 || !c2) throw new Error('色は hex 6桁または3桁で指定してください（例: #333333, fff）');
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return {
    fg: '#' + c1.map((v) => v.toString(16).padStart(2, '0')).join(''),
    bg: '#' + c2.map((v) => v.toString(16).padStart(2, '0')).join(''),
    ratio: Math.round(ratio * 100) / 100,
    aa_normal_text: ratio >= 4.5,
    aa_large_text: ratio >= 3,
    aaa_normal_text: ratio >= 7,
    aaa_large_text: ratio >= 4.5,
    ui_components: ratio >= 3,
  };
}

// X のウェイト1扱い範囲（Latin-1 系・一般句読点の一部）。それ以外（CJK・絵文字等）は2
function charWeight(cp) {
  if ((cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037)) return 1;
  return 2;
}

const URL_RE = /https?:\/\/[^\s]+/g;

function graphemes(s) {
  const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  return [...seg.segment(s)].map((x) => x.segment);
}

/** 文字数・全角/半角・行数・X(Twitter)ウェイト */
export function countChars(text) {
  const v = String(text);
  const gs = graphemes(v);
  let zen = 0;
  let han = 0;
  for (const g of gs) {
    if (/\s/.test(g)) continue;
    charWeight(g.codePointAt(0)) === 1 ? han++ : zen++;
  }
  let weight = (v.match(URL_RE) || []).length * 23;
  for (const g of graphemes(v.replace(URL_RE, ''))) {
    weight += g.length > 1 ? 2 : charWeight(g.codePointAt(0));
  }
  return {
    total: gs.length,
    total_without_whitespace: graphemes(v.replace(/\s/g, '')).length,
    zenkaku: zen,
    hankaku: han,
    lines: v === '' ? 0 : v.split('\n').length,
    x_weight: weight,
    x_weight_limit: 280,
    x_weight_remaining: 280 - weight,
    x_postable: weight <= 280,
  };
}

// ---- llms.txt 生成（site/llms-txt/app.js と同一アルゴリズム・2箇所ルール対象） ----
// spec: { siteName, summary?, notes?, sections?: [{ title, links: [{ title, url, note? }] }] }
export function buildLlmsTxt(spec) {
  const name = String(spec.siteName || '').trim();
  if (!name) throw new Error('siteName は必須です');
  const parts = [`# ${name}`];
  const summary = String(spec.summary || '').trim();
  if (summary) parts.push(summary.split(/\n+/).map((l) => `> ${l.trim()}`).join('\n'));
  const notes = String(spec.notes || '').trim();
  if (notes) parts.push(notes);
  for (const sec of spec.sections || []) {
    const title = String(sec.title || '').trim();
    const links = (sec.links || [])
      .map((l) => ({ title: String(l.title || '').trim(), url: String(l.url || '').trim(), note: String(l.note || '').trim() }))
      .filter((l) => l.title && l.url)
      .map((l) => `- [${l.title}](${l.url})${l.note ? ': ' + l.note : ''}`);
    if (title && links.length) parts.push(`## ${title}\n\n${links.join('\n')}`);
  }
  return parts.join('\n\n') + '\n';
}

// ---- JSON-LD 生成（site/jsonld/app.js と同一アルゴリズム・2箇所ルール対象） ----
// 空の項目はキーごと省略する。fields はタイプ別（下記 builders 参照）。
const trimmed = (v) => String(v ?? '').trim();

const jsonLdBuilders = {
  organization(f) {
    const o = { '@context': 'https://schema.org', '@type': 'Organization' };
    if (trimmed(f.name)) o.name = trimmed(f.name);
    if (trimmed(f.alternateName)) o.alternateName = trimmed(f.alternateName);
    if (trimmed(f.url)) o.url = trimmed(f.url);
    if (trimmed(f.logo)) o.logo = trimmed(f.logo);
    if (trimmed(f.description)) o.description = trimmed(f.description);
    const same = (f.sameAs || []).map(trimmed).filter(Boolean);
    if (same.length) o.sameAs = same;
    return o;
  },
  faqpage(f) {
    const items = (f.faq || [])
      .map((x) => ({ q: trimmed(x.q), a: trimmed(x.a) }))
      .filter((x) => x.q && x.a)
      .map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } }));
    return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items };
  },
  service(f) {
    const o = { '@context': 'https://schema.org', '@type': 'Service' };
    if (trimmed(f.name)) o.name = trimmed(f.name);
    if (trimmed(f.serviceType)) o.serviceType = trimmed(f.serviceType);
    if (trimmed(f.description)) o.description = trimmed(f.description);
    if (trimmed(f.url)) o.url = trimmed(f.url);
    if (trimmed(f.areaServed)) o.areaServed = trimmed(f.areaServed);
    if (trimmed(f.providerName) || trimmed(f.providerUrl)) {
      o.provider = { '@type': 'Organization' };
      if (trimmed(f.providerName)) o.provider.name = trimmed(f.providerName);
      if (trimmed(f.providerUrl)) o.provider.url = trimmed(f.providerUrl);
    }
    return o;
  },
  breadcrumb(f) {
    const items = (f.items || [])
      .map((x) => ({ name: trimmed(x.name), url: trimmed(x.url) }))
      .filter((x) => x.name)
      .map((x, i) => {
        const li = { '@type': 'ListItem', position: i + 1, name: x.name };
        if (x.url) li.item = x.url;
        return li;
      });
    return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
  },
};

export function buildJsonLd(type, fields = {}) {
  const builder = jsonLdBuilders[type];
  if (!builder) throw new Error(`未対応タイプ: ${type}（organization / faqpage / service / breadcrumb のいずれか）`);
  const json = builder(fields);
  const snippet = `<script type="application/ld+json">\n${JSON.stringify(json, null, 2)}\n</script>`;
  return { json, snippet };
}

// ---- 文字コード・改行コード変換（site/encoding/app.js と同一アルゴリズム・2箇所ルール対象） ----
// ブラウザ側は TextDecoder/TextEncoder、Node側は Buffer で同じ結果を返す。
// Shift_JIS のエンコードは Node の標準APIに無いため、変換表を持たず「判定と UTF-8 化」までを担当する。

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

/** 先頭バイトからBOMを判定する。戻り値: 'utf-8' | 'utf-16le' | 'utf-16be' | null */
export function detectBom(bytes) {
  const b = Array.from(bytes.slice(0, 3));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  return null;
}

/** 改行コードを数える。CRLF は CR+LF を1件として扱う */
export function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const kinds = [
    ['CRLF', crlf],
    ['LF', lf],
    ['CR', cr],
  ].filter(([, n]) => n > 0);
  return {
    crlf,
    lf,
    cr,
    dominant: kinds.length ? kinds.sort((a, b) => b[1] - a[1])[0][0] : 'none',
    mixed: kinds.length > 1,
  };
}

/** 改行コードを揃える。newline: 'LF' | 'CRLF' | 'CR' */
export function convertNewline(text, newline) {
  const lf = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (newline === 'CRLF') return lf.replace(/\n/g, '\r\n');
  if (newline === 'CR') return lf.replace(/\n/g, '\r');
  return lf;
}

/** UTF-8 かどうかを厳密に判定する（不正バイト列なら false） */
export function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * バイト列を解析して文字コード・BOM・改行コードを返す。
 * encoding は 'utf-8' | 'shift_jis' を明示できる。未指定なら UTF-8 として妥当かで自動判定する
 * （日本語CSVは実務上ほぼ UTF-8 か Shift_JIS の二択のため、この2つに絞る）。
 */
export function analyzeEncoding(bytes, encoding) {
  const arr = Uint8Array.from(bytes);
  const bom = detectBom(arr);
  const body = bom === 'utf-8' ? arr.slice(3) : arr;
  const enc = encoding || (isValidUtf8(body) ? 'utf-8' : 'shift_jis');
  let text = '';
  let decodable = true;
  try {
    text = new TextDecoder(enc, { fatal: true }).decode(body);
  } catch {
    decodable = false;
    text = new TextDecoder(enc).decode(body); // 置換文字込みで返す
  }
  return {
    encoding: enc,
    encoding_detected: !encoding,
    bom: bom,
    has_bom: bom !== null,
    decodable,
    newline: detectNewline(text),
    bytes: arr.length,
    chars: text.length,
    text,
  };
}

/**
 * 変換して UTF-8 のバイト列を返す。
 * opts: { encoding?, newline?: 'LF'|'CRLF'|'CR', bom?: boolean }
 * Shift_JIS への書き出しは Node 標準では不可能なため、出力は UTF-8 固定にしている。
 */
export function convertEncoding(bytes, opts = {}) {
  const info = analyzeEncoding(bytes, opts.encoding);
  let text = info.text;
  if (opts.newline) text = convertNewline(text, opts.newline);
  const out = new TextEncoder().encode(text);
  const withBom = opts.bom ? Uint8Array.from([...BOM_UTF8, ...out]) : out;
  return {
    from: { encoding: info.encoding, has_bom: info.has_bom, newline: info.newline.dominant },
    to: { encoding: 'utf-8', has_bom: !!opts.bom, newline: opts.newline || info.newline.dominant },
    bytes: withBom.length,
    base64: Buffer.from(withBom).toString('base64'),
    text,
  };
}
