/* URLパラメータの分解・編集・再構築（url_params）
 * 解析コアは FirstCHTools の site/url/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 *
 * URL() は通さず、先頭から `#` → `?` の順に切って分解する。相対パスでも
 * 壊れたパーセントエンコードでも例外にせず読める範囲まで分解でき、
 * 編集していない行は生の文字列のまま書き戻すので、何も指定せずに
 * 再構築したURLは入力と1バイトも変わらない（署名付きURLを壊さない）。 */

export class UrlParamsError extends Error {}

// 手動タグ付けで使うUTMパラメータ（GA4が既定で解釈する6種）
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];

// 広告プラットフォームが自動で付けるクリックID。共有・計測には不要で、消しても遷移先は変わらない
export const CLICK_IDS = [
  'gclid', 'dclid', 'gbraid', 'wbraid', 'gad_source', 'gclsrc',
  'fbclid', 'msclkid', 'ttclid', 'twclid', 'yclid', 'li_fat_id',
  'igshid', 'mc_cid', 'mc_eid', 'vero_id', '_hsenc', '_hsmi', 'oly_enc_id', 'oly_anon_id',
];

// URLに載っていると事故になりうるキー（共有前に外す前提のもの）
const SECRET_KEY = /^(access[_-]?token|id[_-]?token|refresh[_-]?token|token|session[_-]?id|session|sid|auth|authorization|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|pwd|signature|sig)$/i;

const BAD_PERCENT = /%(?![0-9a-fA-F]{2})/;
const HAS_NON_ASCII = /[^\x00-\x7f]/;

/* ---- 文字列のエンコード / デコード ---- */

// パーセントエンコードをバイト単位で解く（%XX が非UTF-8のバイトでも例外にしない）
export function lenientDecode(str) {
  const src = new TextEncoder().encode(String(str));
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length) {
      const hex = String.fromCharCode(src[i + 1], src[i + 2]);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(src[i]);
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(out));
}

// クエリの1トークンを読める文字列へ戻す。壊れた %XX が混じっていても投げない
// （壊れたURLの中身を見るのがこのツールの用途なので、例外で止めない）。
// クエリ文字列では + は歴史的にスペースを表すため、既定で空白へ戻す。
export function decodeComponent(s, plusAsSpace) {
  let t = String(s == null ? '' : s);
  if (plusAsSpace !== false) t = t.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(t);
  } catch (e) {
    return lenientDecode(t);
  }
}

// 値をクエリに書き戻せる形へ。spaceAsPlus のときだけ %20 を + に寄せる
export function encodeComponent(s, spaceAsPlus) {
  const e = encodeURIComponent(String(s == null ? '' : s));
  return spaceAsPlus ? e.replace(/%20/g, '+') : e;
}

/* ---- URLの分解 ---- */

// 先頭から順に # → ? で切る。URL() を通さないので、相対パスでも壊れたURLでも必ず分解でき、
// 触っていない部分は1バイトも変えずに再構築できる。
export function splitUrl(input) {
  const s = String(input == null ? '' : input).trim();
  const hi = s.indexOf('#');
  const hasHash = hi >= 0;
  const hash = hasHash ? s.slice(hi + 1) : '';
  const noHash = hasHash ? s.slice(0, hi) : s;
  const qi = noHash.indexOf('?');
  const hasQuery = qi >= 0;
  return {
    base: hasQuery ? noHash.slice(0, qi) : noHash,
    query: hasQuery ? noHash.slice(qi + 1) : '',
    hash,
    hasQuery,
    hasHash,
  };
}

// 表示用にスキーム・ホスト・パスへ割る。スキームが無いときだけ https を仮定する
// （`example.com/a?b=1` のような貼り付けを受けるため）。相対パスなら null。
export function urlParts(base) {
  const t = String(base == null ? '' : base).trim();
  if (!t) return null;
  let u = null;
  let assumed = false;
  try {
    u = new URL(t);
  } catch (e) { /* 絶対URLではない */ }
  // `/path` は相対パスなので補わない（`https:///path` は余分なスラッシュが詰められて
  // ホスト名 path になってしまう）。ホストらしい先頭要素があるときだけ補う。
  if (!u && !/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(t) && !t.startsWith('/')) {
    const authority = t.split(/[/?#]/)[0];
    if (/\./.test(authority) || /^localhost(:\d+)?$/i.test(authority)) {
      try {
        u = new URL('https://' + t);
        assumed = true;
      } catch (e) { /* ホストとしても読めない */ }
    }
  }
  if (!u) return null;
  if (assumed && !u.hostname) return null;
  return {
    protocol: u.protocol.replace(/:$/, ''),
    username: u.username,
    hasPassword: !!u.password,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    assumedProtocol: assumed,
  };
}

/* ---- クエリパラメータ ---- */

// `a=1&b&c=2` を行の配列へ。生の文字列（rawKey/rawValue）と、
// 解析時点でのデコード結果（origKey/origValue）を両方持たせる。
// 再構築のとき「呼び出し側が触っていない行は生のまま出す」判定に使う。
export function parseQuery(query) {
  const rows = [];
  const q = String(query == null ? '' : query);
  if (!q) return rows;
  for (const token of q.split('&')) {
    if (token === '') continue; // `&&` や末尾の `&` は空トークンなので捨てる
    const eq = token.indexOf('=');
    const rawKey = eq >= 0 ? token.slice(0, eq) : token;
    const rawValue = eq >= 0 ? token.slice(eq + 1) : '';
    const key = decodeComponent(rawKey);
    const value = decodeComponent(rawValue);
    rows.push({ key, value, rawKey, rawValue, origKey: key, origValue: value, hasEq: eq >= 0, on: true });
  }
  return rows;
}

// 行の配列 → クエリ文字列。既定では未編集の行を生のまま出すので、
// 何も触らずに再構築したURLは入力と1バイトも変わらない。
export function buildQuery(rows, opts) {
  const { reencode = false, spaceAsPlus = false } = opts || {};
  const parts = [];
  for (const r of rows || []) {
    if (r.on === false) continue;
    if (r.key === '' && r.value === '') continue;
    const keep = !reencode;
    const k = keep && r.rawKey != null && r.key === r.origKey ? r.rawKey : encodeComponent(r.key, spaceAsPlus);
    const v = keep && r.rawValue != null && r.value === r.origValue ? r.rawValue : encodeComponent(r.value, spaceAsPlus);
    parts.push(r.hasEq === false && v === '' ? k : k + '=' + v);
  }
  return parts.join('&');
}

export function buildUrl(parts) {
  const { base = '', query = '', hash = '', hasHash = false } = parts || {};
  return base + (query ? '?' + query : '') + (hash || hasHash ? '#' + hash : '');
}

/* ---- パラメータの操作 ---- */

const findRow = (rows, key) => rows.findIndex((r) => r.on !== false && r.key === key);

// 既にあるキーは最初の1件を上書きし、無ければ末尾へ足す。値が空文字なら削除。
export function setParam(rows, key, value) {
  const i = findRow(rows, key);
  if (value === '' || value == null) {
    if (i >= 0) rows.splice(i, 1);
    return rows;
  }
  if (i >= 0) {
    rows[i].value = String(value);
    rows[i].hasEq = true;
  } else {
    rows.push({ key: String(key), value: String(value), rawKey: null, rawValue: null, origKey: null, origValue: null, hasEq: true, on: true });
  }
  return rows;
}

export function removeParams(rows, keys) {
  const drop = new Set(keys.map((k) => String(k).toLowerCase()));
  return rows.filter((r) => !drop.has(String(r.key).toLowerCase()));
}

export function getUtm(rows) {
  const out = {};
  for (const k of UTM_KEYS) {
    const i = findRow(rows, k);
    if (i >= 0) out[k] = rows[i].value;
  }
  return out;
}

/* ---- 診断 ---- */

// 返すのはコード＋対象キーだけにして、文言は呼び出し側（サイトは日英・MCPは日本語）で当てる
export function analyzeUrl(state) {
  const { rows = [], parts = null, url = '', hasHash = false, hash = '' } = state || {};
  const live = rows.filter((r) => r.on !== false && !(r.key === '' && r.value === ''));
  const warns = [];
  const add = (code, level, keys) => warns.push({ code, level, keys: keys || [] });

  // 重複キー
  const seen = new Map();
  const dup = [];
  for (const r of live) {
    if (seen.has(r.key)) {
      if (!dup.includes(r.key)) dup.push(r.key);
    } else seen.set(r.key, true);
  }
  if (dup.length) add('dup', 'warn', dup);

  // 生の文字列の作り
  const rawSpace = [];
  const plusSpace = [];
  const nonAscii = [];
  const badPct = [];
  const emptyVal = [];
  for (const r of live) {
    const raw = (r.rawKey || '') + (r.rawValue || '');
    if (r.rawValue != null || r.rawKey != null) {
      if (/ /.test(raw)) rawSpace.push(r.key);
      if (/\+/.test(raw)) plusSpace.push(r.key);
      if (HAS_NON_ASCII.test(raw)) nonAscii.push(r.key);
      if (BAD_PERCENT.test(raw)) badPct.push(r.key);
    }
    if (r.hasEq !== false && r.value === '') emptyVal.push(r.key);
  }
  if (badPct.length) add('bad_percent', 'warn', badPct);
  if (rawSpace.length) add('raw_space', 'warn', rawSpace);
  if (nonAscii.length) add('raw_non_ascii', 'warn', nonAscii);
  if (plusSpace.length) add('plus_space', 'info', plusSpace);
  if (emptyVal.length) add('empty_value', 'info', emptyVal);

  // 秘匿・追跡系
  const secrets = live.filter((r) => SECRET_KEY.test(r.key)).map((r) => r.key);
  if (secrets.length) add('secret', 'warn', secrets);
  const clicks = live.filter((r) => CLICK_IDS.includes(String(r.key).toLowerCase())).map((r) => r.key);
  if (clicks.length) add('click_id', 'info', clicks);

  // UTM
  const utm = getUtm(live);
  const utmSet = Object.keys(utm).filter((k) => utm[k] !== '');
  if (utmSet.length) {
    const upper = utmSet.filter((k) => /[A-Z]/.test(utm[k]));
    if (upper.length) add('utm_case', 'warn', upper);
    const spaced = utmSet.filter((k) => /\s/.test(utm[k]));
    if (spaced.length) add('utm_space', 'warn', spaced);
    if (!utm.utm_source && (utm.utm_medium || utm.utm_campaign)) add('utm_no_source', 'warn', []);
    if (utm.utm_source && !utm.utm_medium) add('utm_no_medium', 'warn', []);
  }

  // 構造
  if (parts && parts.assumedProtocol) add('no_protocol', 'info', []);
  if (parts && parts.protocol === 'http') add('http', 'info', []);
  if (parts && parts.hasPassword) add('userinfo', 'warn', []);
  if (hasHash && /[?=]/.test(hash)) add('hash_query', 'info', []);
  if (url.length > 2000) add('long_url', 'warn', []);

  return warns;
}

/* ---- ここから下はMCP向けの薄い層（Web版のUIに相当する部分） ---- */

const WARN_JA = {
  dup: (k) => `同じキーが複数あります: ${k}。多くのサーバーはどちらか一方だけを採用します（どちらが残るかは実装依存）。`,
  bad_percent: (k) => `${k} のパーセントエンコードが壊れています（% の後ろが16進2桁になっていません）。値は読める範囲までデコードしています。`,
  raw_space: (k) => `${k} にエンコードされていない半角スペースが残っています。チャットやメールに貼るとその位置でリンクが切れます。`,
  raw_non_ascii: (k) => `${k} に非ASCII文字がそのまま入っています。ブラウザは補正しますが、APIクライアントやログ解析では壊れることがあります。`,
  plus_space: (k) => `${k} に + が含まれます。クエリ文字列の + はスペースとして解釈されます（記号としての + は %2B）。`,
  empty_value: (k) => `値が空のパラメータがあります: ${k}。空文字として扱う実装と、未指定として扱う実装があります。`,
  secret: (k) => `${k} は認証情報らしいキーです。URLの値はブラウザ履歴・Referer・アクセスログに残ります。共有しないでください。`,
  click_id: (k) => `広告のクリックIDが残っています: ${k}。広告クリック直後にだけ意味がある値なので、共有・再利用の前に削除してください。`,
  utm_case: (k) => `${k} に大文字が含まれます。GA4はutmの値の大文字小文字を区別するため、Google と google が別の参照元になります。`,
  utm_space: (k) => `${k} にスペースが含まれます。- か _ に置き換えてください。`,
  utm_no_source: () => 'utm_source がありません。GA4は source と medium の組で判定するため、セッションが「(not set)」になります。',
  utm_no_medium: () => 'utm_medium がありません。チャネルグループに割り当てられず「(not set)」として集計されます。',
  no_protocol: () => 'スキームが無いため、分解の表示では https:// を補っています。再構築されるURLは入力したままの形です。',
  http: () => 'http:// のURLです。クエリパラメータは暗号化されずに流れます。',
  userinfo: () => 'URLにパスワードが埋め込まれています（user:pass@host）。ログに残るので外してください。',
  hash_query: () => 'フラグメント（#以降）にもパラメータらしき文字列があります。フラグメントはサーバーへ送信されません。',
  long_url: () => '2,000文字を超えています。プロキシ・メールクライアント・古いサーバーで切り詰められることがあります。',
};

function encodeWith(scheme, s) {
  if (scheme === 'uri') return encodeURI(s);
  if (scheme === 'form') return encodeURIComponent(s).replace(/%20/g, '+');
  return encodeURIComponent(s);
}

function decodeWith(scheme, s) {
  if (scheme === 'uri') {
    try {
      return decodeURI(s);
    } catch (e) {
      return lenientDecode(s);
    }
  }
  return decodeComponent(s, scheme === 'form');
}

/**
 * URLの分解・編集・再構築、または文字列単体のURLエンコード/デコード。
 * mode="parse"（既定）は url が必須。mode="encode"/"decode" は text が必須。
 */
export function urlParams(opts = {}) {
  const {
    url,
    mode = 'parse',
    text,
    scheme = 'component',
    set = null,
    remove = null,
    utm = null,
    sort = false,
    removeTracking = false,
    reencode = false,
    spaceAsPlus = false,
  } = opts;

  if (!['parse', 'encode', 'decode'].includes(mode)) {
    throw new UrlParamsError(`mode は parse / encode / decode のいずれか（受け取った値: ${mode}）`);
  }
  if (!['component', 'uri', 'form'].includes(scheme)) {
    throw new UrlParamsError(`scheme は component / uri / form のいずれか（受け取った値: ${scheme}）`);
  }

  if (mode === 'encode' || mode === 'decode') {
    if (typeof text !== 'string') throw new UrlParamsError('mode="' + mode + '" では text（文字列）が必要');
    const out = mode === 'encode' ? encodeWith(scheme, text) : decodeWith(scheme, text);
    return { mode, scheme, input: text, output: out, length: out.length };
  }

  if (typeof url !== 'string' || url.trim() === '') throw new UrlParamsError('url（分解するURL）が必要');

  const s = splitUrl(url);
  let rows = parseQuery(s.query);
  const removed = [];

  if (removeTracking) {
    const before = rows.length;
    const hit = rows.filter((r) => CLICK_IDS.includes(String(r.key).toLowerCase())).map((r) => r.key);
    rows = removeParams(rows, CLICK_IDS);
    if (rows.length !== before) removed.push(...hit);
  }
  if (Array.isArray(remove) && remove.length) {
    const hit = rows.filter((r) => remove.some((k) => String(k).toLowerCase() === String(r.key).toLowerCase())).map((r) => r.key);
    rows = removeParams(rows, remove);
    removed.push(...hit);
  }
  if (set && typeof set === 'object') {
    for (const [k, v] of Object.entries(set)) setParam(rows, k, v == null ? '' : String(v));
  }
  if (utm && typeof utm === 'object') {
    for (const [k, v] of Object.entries(utm)) {
      // source / utm_source のどちらの書き方も受ける
      const key = UTM_KEYS.includes(k) ? k : 'utm_' + k;
      if (!UTM_KEYS.includes(key)) throw new UrlParamsError(`utm のキーが不正: ${k}（使えるのは ${UTM_KEYS.join(' / ')}）`);
      setParam(rows, key, v == null ? '' : String(v));
    }
  }
  if (sort) rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const query = buildQuery(rows, { reencode, spaceAsPlus });
  const rebuilt = buildUrl({ base: s.base, query, hash: s.hash, hasHash: s.hasHash });
  const parts = urlParts(s.base);
  const warns = analyzeUrl({ rows, parts, url: rebuilt, hasHash: s.hasHash, hash: s.hash });
  const live = rows.filter((r) => r.on !== false && !(r.key === '' && r.value === ''));
  const seen = new Set();
  let duplicates = 0;
  for (const r of live) {
    if (seen.has(r.key)) duplicates++;
    else seen.add(r.key);
  }

  return {
    mode: 'parse',
    input: String(url).trim(),
    url: rebuilt,
    changed: rebuilt !== String(url).trim(),
    protocol: parts ? parts.protocol : null,
    host: parts ? parts.host : null,
    hostname: parts ? parts.hostname : null,
    port: parts && parts.port ? parts.port : null,
    path: parts ? parts.pathname : null,
    assumed_protocol: parts ? parts.assumedProtocol : false,
    hash: s.hasHash ? s.hash : null,
    params: live.map((r) => ({
      key: r.key,
      value: r.value,
      raw_key: r.rawKey,
      raw_value: r.rawValue,
      value_only_key: r.hasEq === false,
    })),
    utm: getUtm(live),
    removed,
    warnings: warns.map((w) => ({
      code: w.code,
      level: w.level,
      keys: w.keys,
      message_ja: (WARN_JA[w.code] || (() => w.code))(w.keys.join(', ')),
    })),
    stats: {
      params: live.length,
      duplicates,
      url_length: rebuilt.length,
      query_length: query.length,
    },
  };
}
