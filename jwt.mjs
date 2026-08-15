// JWT（JSON Web Token）のデコード・有効期限チェック・署名の検証
// （tools.first-ch.com/jwt/ と同一の仕様）
//
// 2箇所ルール: デコードのコア（normalizeInput / decodeSegment / decodeJwt / analyzeTiming /
// collectWarnings / verifySignature）は site/jwt/app.js と対になっている。
// 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 署名の検証は site 側がブラウザの Web Crypto、こちらは node:crypto の webcrypto を使う。
// importKey / verify の呼び出し方は同じで、対応アルゴリズムも揃えてある。
// トークンも鍵もこのプロセスの中だけで扱い、ネットワークへは一切出さない。
import { webcrypto } from 'node:crypto';

export class JwtError extends Error {}

const subtle = webcrypto.subtle;

/** 署名アルゴリズムの一覧。JWS（RFC 7518）で定義されているもの＋EdDSA（RFC 8037） */
export const ALGS = {
  HS256: { kind: 'hmac', hash: 'SHA-256' },
  HS384: { kind: 'hmac', hash: 'SHA-384' },
  HS512: { kind: 'hmac', hash: 'SHA-512' },
  RS256: { kind: 'rsa', hash: 'SHA-256' },
  RS384: { kind: 'rsa', hash: 'SHA-384' },
  RS512: { kind: 'rsa', hash: 'SHA-512' },
  PS256: { kind: 'rsapss', hash: 'SHA-256', saltLength: 32 },
  PS384: { kind: 'rsapss', hash: 'SHA-384', saltLength: 48 },
  PS512: { kind: 'rsapss', hash: 'SHA-512', saltLength: 64 },
  ES256: { kind: 'ec', hash: 'SHA-256', curve: 'P-256' },
  ES384: { kind: 'ec', hash: 'SHA-384', curve: 'P-384' },
  ES512: { kind: 'ec', hash: 'SHA-512', curve: 'P-521' },
  EdDSA: { kind: 'eddsa' },
  none: { kind: 'none' },
};

/** base64url（標準Base64・パディング付きも許す）を Buffer にする */
export function b64uToBytes(seg) {
  let s = String(seg).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const rest = s.length % 4;
  // 4で割った余りが1になる長さのBase64は存在しない
  if (rest === 1) throw new JwtError('base64');
  if (rest) s += '='.repeat(4 - rest);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new JwtError('base64');
  return Buffer.from(s, 'base64');
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** 1セグメントをデコードして {text, json, error} を返す */
function decodeSegment(seg) {
  let bytes;
  try {
    bytes = b64uToBytes(seg);
  } catch (e) {
    return { text: '', json: null, error: 'base64' };
  }
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch (e) {
    return { text: '', json: null, error: 'utf8' };
  }
  try {
    return { text, json: JSON.parse(text), error: '' };
  } catch (e) {
    return { text, json: null, error: 'json' };
  }
}

/**
 * 貼り付けられた文字列からトークン本体を取り出す。
 * `Authorization: Bearer <token>` の行・引用符・途中の改行や空白をそのまま渡せる。
 */
export function normalizeInput(raw) {
  const cleanups = [];
  const mark = (c) => { if (cleanups.indexOf(c) === -1) cleanups.push(c); };
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { token: '', cleanups };
  // `"Bearer …",` のように包みが重なっていることがあるので、変化しなくなるまで繰り返す
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    const header = s.match(/^authorization\s*:\s*(.*)$/is);
    if (header) {
      s = header[1].trim();
      mark('header');
    }
    const bearer = s.match(/^bearer\s+(.*)$/is);
    if (bearer) {
      s = bearer[1].trim();
      mark('bearer');
    }
    // 末尾のカンマ・セミコロンはコードからコピーしたときに付いてくる
    const tail = s.replace(/[,;]+$/, '');
    if (tail !== s) {
      s = tail.trim();
      mark('punct');
    }
    if (s.length > 1 && /^["'`]/.test(s) && s[0] === s[s.length - 1]) {
      s = s.slice(1, -1).trim();
      mark('quoted');
    }
    if (s === before) break;
  }
  if (/\s/.test(s)) {
    s = s.replace(/\s+/g, '');
    cleanups.push('whitespace');
  }
  return { token: s, cleanups };
}

/** JWT（JWS compact serialization）をデコードする。署名の検証は行わない */
export function decodeJwt(raw) {
  const { token, cleanups } = normalizeInput(raw);
  const out = {
    ok: false,
    token,
    cleanups,
    type: '',
    parts: token ? token.split('.') : [],
    header: null,
    payload: null,
    headerText: '',
    payloadText: '',
    signature: '',
    signingInput: '',
    errors: [],
  };
  if (!token) {
    out.errors.push('empty');
    return out;
  }
  const parts = out.parts;
  if (parts.length === 5) {
    // JWE（暗号化トークン）はヘッダーしか読めない
    out.type = 'jwe';
    const h = decodeSegment(parts[0]);
    out.header = h.json;
    out.headerText = h.json ? JSON.stringify(h.json, null, 2) : h.text;
    if (h.error) out.errors.push('header_' + h.error);
    out.errors.push('jwe');
    return out;
  }
  if (parts.length < 2 || parts.length > 3) {
    out.errors.push('not_jwt');
    return out;
  }
  out.type = 'jws';
  if (parts.length === 2) out.errors.push('two_parts');

  const h = decodeSegment(parts[0]);
  if (h.error) {
    out.errors.push('header_' + h.error);
    out.headerText = h.text;
  } else {
    out.header = h.json;
    out.headerText = JSON.stringify(h.json, null, 2);
    if (h.json === null || typeof h.json !== 'object' || Array.isArray(h.json)) {
      out.errors.push('header_not_object');
    }
  }

  const p = decodeSegment(parts[1]);
  if (p.error) {
    out.errors.push('payload_' + p.error);
    out.payloadText = p.text;
  } else {
    out.payload = p.json;
    out.payloadText = JSON.stringify(p.json, null, 2);
    if (p.json === null || typeof p.json !== 'object' || Array.isArray(p.json)) {
      out.errors.push('payload_not_object');
    }
  }

  out.signature = parts[2] || '';
  out.signingInput = parts[0] + '.' + parts[1];
  // ヘッダーとペイロードが読めていれば「デコードできた」とみなす（署名の有無は別）
  out.ok = !h.error && !p.error;
  return out;
}

/** 数値のクレームを読む。文字列の数値・ミリ秒での指定も拾う */
export function readTimeClaim(payload, key) {
  if (!payload || typeof payload !== 'object') return null;
  const v = payload[key];
  let num = null;
  let coerced = false;
  if (typeof v === 'number' && isFinite(v)) {
    num = v;
  } else if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())) {
    num = Number(v);
    coerced = true;
  } else {
    return v === undefined ? null : { raw: v, seconds: null, ms: false, coerced: false, invalid: true };
  }
  // 1e11 秒は西暦5138年。この桁はまずミリ秒の入れ間違い（Date.now() をそのまま入れた）
  const ms = Math.abs(num) >= 1e11;
  return { raw: v, seconds: ms ? Math.floor(num / 1000) : Math.floor(num), ms, coerced, invalid: false };
}

/** exp / nbf / iat から有効期限の状態を出す */
export function analyzeTiming(payload, nowSec, tolerance) {
  const tol = tolerance || 0;
  const exp = readTimeClaim(payload, 'exp');
  const nbf = readTimeClaim(payload, 'nbf');
  const iat = readTimeClaim(payload, 'iat');
  const t = {
    now: nowSec,
    exp: exp && !exp.invalid ? exp.seconds : null,
    nbf: nbf && !nbf.invalid ? nbf.seconds : null,
    iat: iat && !iat.invalid ? iat.seconds : null,
    expMs: Boolean(exp && exp.ms),
    nbfMs: Boolean(nbf && nbf.ms),
    iatMs: Boolean(iat && iat.ms),
    invalid: [exp, nbf, iat].some((c) => c && c.invalid),
    status: 'no_exp',
    remaining: null,
    age: null,
    lifetime: null,
    progress: null,
    start: null,
  };
  if (t.exp !== null) {
    t.remaining = t.exp - nowSec;
    t.status = nowSec - tol >= t.exp ? 'expired' : 'valid';
  }
  if (t.nbf !== null && nowSec + tol < t.nbf && t.status !== 'expired') t.status = 'not_yet';
  if (t.iat !== null) t.age = nowSec - t.iat;
  // 経過の割合を出す基準。iat が無ければ nbf を使う
  const start = t.iat !== null ? t.iat : t.nbf;
  if (start !== null && t.exp !== null && t.exp > start) {
    t.start = start;
    t.lifetime = t.exp - start;
    t.progress = Math.min(1, Math.max(0, (nowSec - start) / t.lifetime));
  }
  return t;
}

/** ペイロードに入っていたら注意したいキー */
const SECRET_KEYS = /^(password|passwd|pwd|secret|client_secret|api_?key|access_?key|private_?key|credit_?card|card_?number|cvv|cvc|ssn|my_?number|pin)$/i;
const PII_KEYS = /^(email|mail|e_?mail|phone|tel|telephone|mobile|address|birthdate|birth_?day|name|given_?name|family_?name|preferred_username)$/i;

/** デコード結果から指摘事項のコード一覧を作る（文言は下の WARN が持つ） */
export function collectWarnings(decoded, timing) {
  const w = [];
  const header = decoded.header || {};
  const payload = decoded.payload && typeof decoded.payload === 'object' ? decoded.payload : {};
  const alg = typeof header.alg === 'string' ? header.alg : '';

  for (const c of decoded.cleanups) w.push({ code: 'clean_' + c, level: 'info' });

  if (decoded.errors.indexOf('jwe') !== -1) w.push({ code: 'jwe', level: 'warn' });
  if (decoded.errors.indexOf('not_jwt') !== -1) w.push({ code: 'not_jwt', level: 'warn' });
  if (decoded.errors.indexOf('two_parts') !== -1) w.push({ code: 'two_parts', level: 'warn' });
  for (const seg of ['header', 'payload']) {
    if (decoded.errors.indexOf(seg + '_base64') !== -1) w.push({ code: seg + '_base64', level: 'warn' });
    if (decoded.errors.indexOf(seg + '_utf8') !== -1) w.push({ code: seg + '_utf8', level: 'warn' });
    if (decoded.errors.indexOf(seg + '_json') !== -1) w.push({ code: seg + '_json', level: 'warn' });
  }
  if (!decoded.ok) return w;

  if (!alg) {
    w.push({ code: 'no_alg', level: 'warn' });
  } else if (alg.toLowerCase() === 'none') {
    w.push({ code: 'alg_none', level: 'warn' });
  } else if (!ALGS[alg]) {
    w.push({ code: 'unknown_alg', level: 'warn', arg: alg });
  }
  if (alg && alg.toLowerCase() !== 'none' && !decoded.signature) w.push({ code: 'no_signature', level: 'warn' });
  if (header.typ !== undefined && String(header.typ).toUpperCase() !== 'JWT' && String(header.typ).toLowerCase() !== 'at+jwt') {
    w.push({ code: 'typ_other', level: 'info', arg: String(header.typ) });
  }

  if (timing.invalid) w.push({ code: 'time_invalid', level: 'warn' });
  if (timing.expMs || timing.iatMs || timing.nbfMs) w.push({ code: 'time_ms', level: 'warn' });
  if (timing.status === 'expired') w.push({ code: 'expired', level: 'warn', arg: -timing.remaining });
  if (timing.status === 'not_yet') w.push({ code: 'not_yet', level: 'warn', arg: timing.nbf - timing.now });
  if (timing.exp === null) w.push({ code: 'no_exp', level: 'warn' });
  if (timing.lifetime !== null && timing.lifetime > 86400 * 30) {
    w.push({ code: 'lifetime_long', level: 'warn', arg: timing.lifetime });
  } else if (timing.lifetime !== null && timing.lifetime > 86400) {
    w.push({ code: 'lifetime_day', level: 'info', arg: timing.lifetime });
  }
  if (timing.iat !== null && timing.iat - timing.now > 60) w.push({ code: 'iat_future', level: 'warn' });

  const keys = Object.keys(payload);
  const secret = keys.filter((k) => SECRET_KEYS.test(k));
  if (secret.length) w.push({ code: 'secret_claim', level: 'warn', arg: secret.join(', ') });
  const pii = keys.filter((k) => PII_KEYS.test(k));
  if (pii.length) w.push({ code: 'pii_claim', level: 'info', arg: pii.join(', ') });
  if (payload.aud === undefined) w.push({ code: 'no_aud', level: 'info' });
  if (payload.jti === undefined && timing.exp !== null) w.push({ code: 'no_jti', level: 'info' });

  w.push({ code: 'not_verified', level: 'info' });
  return w;
}

/* ==================== 署名の検証（site/jwt/app.js と同じ呼び出し方） ==================== */

const ENC = new TextEncoder();

function pemToBytes(text) {
  const body = text.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  return b64uToBytes(body);
}

/** JWK から Web Crypto へ渡す最小限の members だけを取り出す（alg / use の不一致で弾かれないため） */
function cleanJwk(jwk) {
  const out = { kty: jwk.kty, ext: true };
  for (const k of ['n', 'e', 'crv', 'x', 'y']) if (jwk[k] !== undefined) out[k] = jwk[k];
  return out;
}

function jwkParams(alg, spec) {
  if (spec.kind === 'rsa') return { name: 'RSASSA-PKCS1-v1_5', hash: spec.hash };
  if (spec.kind === 'rsapss') return { name: 'RSA-PSS', hash: spec.hash };
  if (spec.kind === 'ec') return { name: 'ECDSA', namedCurve: spec.curve };
  return { name: 'Ed25519' };
}

function verifyParams(spec) {
  if (spec.kind === 'hmac') return { name: 'HMAC' };
  if (spec.kind === 'rsa') return { name: 'RSASSA-PKCS1-v1_5' };
  if (spec.kind === 'rsapss') return { name: 'RSA-PSS', saltLength: spec.saltLength };
  if (spec.kind === 'ec') return { name: 'ECDSA', hash: spec.hash };
  return { name: 'Ed25519' };
}

/** HMAC の鍵素材を作る。encoding は utf8 / base64url / base64 / hex */
export function secretToBytes(secret, encoding) {
  if (encoding === 'hex') {
    const s = secret.replace(/[\s:-]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new JwtError('key_format:hex');
    return Buffer.from(s, 'hex');
  }
  if (encoding === 'base64' || encoding === 'base64url') {
    try {
      return b64uToBytes(secret);
    } catch (e) {
      throw new JwtError('key_format:base64');
    }
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * 署名を検証する。鍵はこのプロセスから出ない。
 * @returns {Promise<{status: string, code: string, arg?: string}>}
 *   status: verified | failed | error | skipped
 */
export async function verifySignature(decoded, key, encoding) {
  if (!decoded.ok || decoded.type !== 'jws') return { status: 'skipped', code: 'no_token' };
  const alg = decoded.header && typeof decoded.header.alg === 'string' ? decoded.header.alg : '';
  const spec = ALGS[alg];
  if (!alg) return { status: 'error', code: 'no_alg' };
  if (alg.toLowerCase() === 'none') return { status: 'error', code: 'alg_none' };
  if (!spec) return { status: 'error', code: 'unknown_alg', arg: alg };
  if (!decoded.signature) return { status: 'error', code: 'no_signature' };
  if (!String(key == null ? '' : key).trim()) return { status: 'skipped', code: 'no_key' };

  let sig;
  try {
    sig = b64uToBytes(decoded.signature);
  } catch (e) {
    return { status: 'error', code: 'bad_signature' };
  }
  // ECDSA の署名は R‖S の生バイト（DER ではない）。長さで取り違えを検出できる
  if (spec.kind === 'ec') {
    const need = { 'P-256': 64, 'P-384': 96, 'P-521': 132 }[spec.curve];
    if (sig.length !== need) return { status: 'error', code: 'ec_sig_length', arg: sig.length + ' / ' + need };
  }
  const data = ENC.encode(decoded.signingInput);
  const text = String(key).trim();

  let cryptoKey;
  try {
    if (spec.kind === 'hmac') {
      let raw;
      if (text[0] === '{') {
        const jwk = JSON.parse(text);
        const k = jwk.keys ? (jwk.keys.find((x) => x.kid === (decoded.header || {}).kid) || jwk.keys[0]) : jwk;
        if (!k || k.kty !== 'oct' || !k.k) return { status: 'error', code: 'jwk_not_oct' };
        raw = b64uToBytes(k.k);
      } else {
        raw = secretToBytes(text, encoding);
      }
      if (!raw.length) return { status: 'error', code: 'empty_key' };
      cryptoKey = await subtle.importKey('raw', raw, { name: 'HMAC', hash: spec.hash }, false, ['verify']);
    } else if (text[0] === '{') {
      const parsed = JSON.parse(text);
      const jwk = parsed.keys
        ? (parsed.keys.find((x) => x.kid === (decoded.header || {}).kid) || parsed.keys[0])
        : parsed;
      if (!jwk || !jwk.kty) return { status: 'error', code: 'jwk_invalid' };
      if (jwk.d) return { status: 'error', code: 'private_key' };
      cryptoKey = await subtle.importKey('jwk', cleanJwk(jwk), jwkParams(alg, spec), false, ['verify']);
    } else {
      if (/BEGIN [A-Z ]*PRIVATE KEY/.test(text)) return { status: 'error', code: 'private_key' };
      if (/BEGIN CERTIFICATE/.test(text)) return { status: 'error', code: 'certificate' };
      if (/BEGIN RSA PUBLIC KEY/.test(text)) return { status: 'error', code: 'pkcs1' };
      cryptoKey = await subtle.importKey('spki', pemToBytes(text), jwkParams(alg, spec), false, ['verify']);
    }
  } catch (e) {
    if (String(e && e.message).indexOf('key_format:') === 0) {
      return { status: 'error', code: 'key_format', arg: String(e.message).split(':')[1] };
    }
    if (e instanceof SyntaxError) return { status: 'error', code: 'jwk_invalid' };
    return { status: 'error', code: 'key_import', arg: String((e && e.message) || e) };
  }

  let ok;
  try {
    ok = await subtle.verify(verifyParams(spec), cryptoKey, sig, data);
  } catch (e) {
    return { status: 'error', code: 'verify_failed', arg: String((e && e.message) || e) };
  }
  return ok ? { status: 'verified', code: 'verified' } : { status: 'failed', code: 'mismatch' };
}

/* ==================== 文言（site 側の T.W / T.V と同じ内容） ==================== */

const WARN = {
  clean_header: () => '先頭の `Authorization:` を取り除いてからデコードしました。',
  clean_bearer: () => '先頭の `Bearer ` を取り除いてからデコードしました。',
  clean_quoted: () => '前後の引用符を取り除いてからデコードしました。',
  clean_punct: () => '末尾のカンマ・セミコロンを取り除いてからデコードしました。',
  clean_whitespace: () => 'トークンの途中にあった改行・空白を詰めてデコードしました。JWTは切れ目のない1本の文字列です。',
  empty: () => 'トークンが空です。',
  not_jwt: () => 'JWTとして読めません。JWTは `ヘッダー.ペイロード.署名` の3つをドットでつないだ形です。',
  two_parts: () => 'セグメントが2つしかありません。署名なし（alg: none）のトークンでも末尾のドットは必要です。',
  jwe: () => 'セグメントが5つあります。これは JWE（暗号化されたトークン）で、読めるのはヘッダーだけです。復号には受信者の秘密鍵が要ります。',
  header_base64: () => 'ヘッダー部が base64url として壊れています。',
  payload_base64: () => 'ペイロード部が base64url として壊れています。',
  header_utf8: () => 'ヘッダー部が UTF-8 として読めません。',
  payload_utf8: () => 'ペイロード部が UTF-8 として読めません。',
  header_json: () => 'ヘッダー部はデコードできましたが、JSONとして読めません。',
  payload_json: () => 'ペイロード部はデコードできましたが、JSONとして読めません（入れ子のJWTなど、JWSでは正しい場合もあります）。',
  header_not_object: () => 'ヘッダーがJSONのオブジェクトではありません。',
  payload_not_object: () => 'ペイロードがJSONのオブジェクトではないため、読み取れるクレームがありません。',
  no_alg: () => 'ヘッダーに `alg` がありません。JWSのヘッダーには必ず必要です。',
  alg_none: () => '`alg: none` — 署名がないトークンです。誰でもペイロードを書き換えられるので、意図して許可している場合を除き、受け取る側は拒否しなければいけません。',
  unknown_alg: (a) => `未知のアルゴリズム \`${a}\` です。署名を検証できません。`,
  no_signature: () => 'アルゴリズムが指定されているのに署名部が空です。このトークンは検証できません。',
  typ_other: (t) => `\`typ\` が \`JWT\` ではなく \`${t}\` です（OAuthのアクセストークンの \`at+jwt\` など、規格上は正しい形です）。`,
  time_invalid: () => '`exp` / `nbf` / `iat` は数値（1970年からの秒数）である必要があります。数値でない値が入っています。',
  time_ms: () => '時刻のクレームがミリ秒（`Date.now()` の値）に見えます。JWTの時刻は秒です。1000で割り忘れていると、事実上いつまでも期限切れになりません。',
  expired: (d) => `このトークンは ${d} 前に期限切れです。正しく実装されたサーバーは受け付けません。`,
  not_yet: (d) => `まだ有効ではありません（\`nbf\` が ${d} 先）。発行側と受信側の時計のズレが原因のことが多いです。`,
  no_exp: () => '`exp` が無いため、このトークンは自然には失効しません。漏れた場合、鍵を替えるかサーバー側で失効させるまで使われ続けます。',
  lifetime_long: (d) => `有効期間が ${d} あります。アクセストークンとしては長すぎます（短命のアクセストークン＋リフレッシュトークンが一般的）。`,
  lifetime_day: (d) => `有効期間は ${d} です。`,
  iat_future: () => '`iat` が未来の時刻です。発行側の時計が進んでいる可能性があります。',
  secret_claim: (k) => `ペイロードに \`${k}\` が入っています。JWTのペイロードは base64url で符号化されているだけで暗号化ではありません。秘密情報を入れてはいけません。`,
  pii_claim: (k) => `ペイロードに個人情報（\`${k}\`）が入っています。トークンを持つ人は誰でも読めることを前提にしてください。`,
  no_aud: () => '`aud`（想定する受け手）がありません。同じ鍵を信頼している別のサービスへ使い回されるおそれがあります。',
  no_jti: () => '`jti`（トークンID）がありません。個別のトークンの失効や二重使用の検出に使えます。',
  not_verified: () => 'デコードは署名の検証ではありません。改ざんの有無を確かめるには key を渡して署名を検証してください。',
};

const VERDICT = {
  no_token: () => 'デコードできるトークンがありません。',
  no_key: () => 'key を渡すと署名を検証します。',
  no_alg: () => 'ヘッダーに `alg` が無いため検証できません。',
  alg_none: () => '`alg: none` のため検証する署名がありません。意図して許可していない限り、このトークンは拒否してください。',
  unknown_alg: (a) => `\`${a}\` は検証に対応していません。`,
  no_signature: () => '署名部が空です。',
  bad_signature: () => '署名部が base64url として壊れています。',
  ec_sig_length: (a) => `署名の長さが曲線と合いません（${a} バイト）。JWSのECDSA署名は DER ではなく R‖S の生の形です。`,
  jwk_not_oct: () => 'HS* の検証に使うJWKは共有鍵（`"kty":"oct"` と `k`）である必要があります。',
  jwk_invalid: () => '鍵をJSON（JWK / JWKS）として読み取れませんでした。',
  private_key: () => '秘密鍵が渡されています。検証に使うのは公開鍵（SPKI形式のPEM）または公開鍵のJWKです。',
  certificate: () => 'X.509証明書が渡されています。`openssl x509 -pubkey -noout -in cert.pem` で公開鍵を取り出してください。',
  pkcs1: () => 'PKCS#1形式（`BEGIN RSA PUBLIC KEY`）です。`openssl rsa -RSAPublicKey_in -in key.pem -pubout` でSPKI形式へ変換してください。',
  key_format: (f) => `鍵を ${f} として読み取れませんでした。keyEncoding を確認してください。`,
  empty_key: () => '鍵が空です。',
  key_import: (m) => `鍵を読み込めませんでした: ${m}`,
  verify_failed: (m) => `検証を実行できませんでした: ${m}`,
  verified: () => '署名は正しく、ヘッダーとペイロードは署名された時点から書き換えられていません。',
  mismatch: () => '署名が一致しません。鍵が違うか、署名後にトークンが書き換えられています。',
  short_secret: () => '共有鍵がハッシュ長より短いです。RFC 7518 はHMACの鍵にハッシュと同じ長さ（HS256なら32バイト）以上を求めています。',
};

/** クレームの説明（site 側 CLAIMS の日本語と同じ） */
export const CLAIM_DOCS = {
  iss: 'Issuer — このトークンを発行したサーバー。受け取る側は想定した発行者かを必ず確認する。',
  sub: 'Subject — トークンが誰（何）についてのものか。多くはユーザーID。',
  aud: 'Audience — このトークンを受け取ってよいサービス。自分宛でなければ拒否する。',
  exp: 'Expiration Time — この時刻を過ぎたトークンは受け付けてはいけない。',
  nbf: 'Not Before — この時刻より前は受け付けてはいけない。',
  iat: 'Issued At — トークンが作られた時刻。',
  jti: 'JWT ID — トークン1件ごとの識別子。失効管理や二重使用の検出に使う。',
  azp: 'Authorized Party — このトークンの発行を受けたクライアント（OIDC）。',
  nonce: 'Nonce — 認可リクエストで送った値。リプレイ攻撃の検出に使う（OIDC）。',
  auth_time: 'Authentication Time — 利用者が実際に認証を行った時刻（OIDC）。',
  acr: 'Auth Context Class — 満たされた認証の強度（OIDC）。',
  amr: 'Auth Methods — 実際に使われた認証手段（OIDC）。',
  scope: 'Scope — このトークンで許可されている操作の範囲（空白区切り）。',
  scp: 'Scope — スコープの別表記（Azure AD など）。',
  client_id: 'Client ID — トークンの発行を受けたアプリケーション。',
  sid: 'Session ID — シングルログアウトで使うセッションの識別子（OIDC）。',
  email: 'Email — 利用者のメールアドレス。誰でも読めることに注意。',
  email_verified: 'Email Verified — メールアドレスが確認済みかどうか。',
  name: 'Name — 利用者の表示名。',
  given_name: 'Given Name — 利用者の名。',
  family_name: 'Family Name — 利用者の姓。',
  preferred_username: 'Preferred Username — 利用者が名乗っている名前。一意とは限らない。',
  picture: 'Picture — プロフィール画像のURL。',
  locale: 'Locale — 利用者の言語・地域設定。',
  updated_at: 'Updated At — プロフィールが最後に更新された時刻。',
  roles: 'Roles — アプリケーション側の権限（独自クレーム）。',
  permissions: 'Permissions — 個別に許可された操作（独自クレーム）。',
  groups: 'Groups — 所属グループ（独自クレーム）。',
  token_use: 'Token Use — access か id か（Amazon Cognito）。',
  alg: 'Algorithm — 署名に使われたアルゴリズム。',
  typ: 'Type — トークンの型。通常は JWT。',
  cty: 'Content Type — 入れ子のJWTなど、ペイロードの型。',
  kid: 'Key ID — 検証に使う公開鍵を JWKS から選ぶための識別子。',
  jku: 'JWK Set URL — 公開鍵の一覧（JWKS）の場所。信頼できるURLか必ず確認する。',
  x5t: 'X.509 Thumbprint — 検証に使う証明書のSHA-1指紋。',
  x5c: 'X.509 Chain — 検証に使う証明書そのもの。',
  crit: 'Critical — 受け取る側が必ず解釈しなければならない拡張ヘッダーの一覧。',
  enc: 'Encryption — JWEで本文の暗号化に使うアルゴリズム。',
};

const TIME_CLAIMS = ['exp', 'nbf', 'iat', 'auth_time', 'updated_at'];

/** 秒数を「2日3時間」のような文字列にする（site 側 fmtDuration と同じ規則） */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Math.abs(sec)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = [];
  if (d) parts.push(d + '日');
  if (h) parts.push(h + '時間');
  if (m && d === 0) parts.push(m + '分');
  if (!d && !h && (ss || !m)) parts.push(ss + '秒');
  return parts.join('');
}

function warnText(w) {
  const f = WARN[w.code];
  if (!f) return w.code;
  if (['expired', 'not_yet', 'lifetime_long', 'lifetime_day'].indexOf(w.code) !== -1) return f(formatDuration(w.arg));
  return f(w.arg);
}

const iso = (sec) => {
  const d = new Date(sec * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * JWTをデコードし、有効期限を判定して（鍵があれば）署名を検証する。
 *
 * @param {object} opts
 * @param {string} opts.token           デコードするJWT（`Authorization: Bearer …` のままでも可）
 * @param {string} [opts.key]           署名の検証に使う共有鍵（HS*）または公開鍵（PEM / JWK / JWKS）
 * @param {'utf8'|'base64url'|'base64'|'hex'} [opts.keyEncoding='utf8'] 共有鍵の読み方
 * @param {number} [opts.clockTolerance=0] 許容する時計のズレ（秒）
 * @param {number} [opts.now]           判定に使う現在時刻（UNIX秒。既定は実時刻）
 */
export async function jwtDecode(opts = {}) {
  if (typeof opts.token !== 'string' || !opts.token.trim()) throw new JwtError('token を渡してください');
  const keyEncoding = opts.keyEncoding || 'utf8';
  if (['utf8', 'base64url', 'base64', 'hex'].indexOf(keyEncoding) === -1) {
    throw new JwtError(`keyEncoding は utf8 / base64url / base64 / hex: ${opts.keyEncoding}`);
  }
  const tolerance = opts.clockTolerance === undefined ? 0 : Number(opts.clockTolerance);
  if (!isFinite(tolerance) || tolerance < 0) throw new JwtError('clockTolerance は0以上の秒数で渡してください');
  const now = opts.now === undefined ? Math.floor(Date.now() / 1000) : Math.floor(Number(opts.now));
  if (!isFinite(now)) throw new JwtError('now はUNIX秒で渡してください');

  const decoded = decodeJwt(opts.token);
  const timing = analyzeTiming(decoded.payload, now, tolerance);
  const warnings = collectWarnings(decoded, timing);

  const result = {
    format: decoded.type || 'unknown',
    decoded: decoded.ok,
    header: decoded.header,
    payload: decoded.payload,
    signature: decoded.signature || null,
  };

  if (decoded.type === 'jws') {
    result.expiry = {
      status: timing.status, // valid / expired / not_yet / no_exp
      checked_at: iso(now),
      clock_tolerance_seconds: tolerance,
      expires_at: timing.exp === null ? null : iso(timing.exp),
      not_before: timing.nbf === null ? null : iso(timing.nbf),
      issued_at: timing.iat === null ? null : iso(timing.iat),
      remaining_seconds: timing.remaining,
      remaining: timing.remaining === null ? null
        : (timing.remaining >= 0 ? `残り${formatDuration(timing.remaining)}` : `${formatDuration(timing.remaining)}前に期限切れ`),
      lifetime_seconds: timing.lifetime,
      elapsed_ratio: timing.progress === null ? null : Math.round(timing.progress * 1000) / 1000,
    };

    // 説明を付けられるクレームだけを一覧にする（独自クレームは payload をそのまま見る）
    const claims = [];
    for (const [where, obj] of [['header', decoded.header], ['payload', decoded.payload]]) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const k of Object.keys(obj)) {
        const entry = { name: k, in: where, value: obj[k] };
        if (CLAIM_DOCS[k]) entry.meaning = CLAIM_DOCS[k];
        if (where === 'payload' && TIME_CLAIMS.indexOf(k) !== -1) {
          const t = readTimeClaim(obj, k);
          if (t && !t.invalid) entry.datetime = iso(t.seconds);
        }
        claims.push(entry);
      }
    }
    result.claims = claims;
  }

  const verification = await verifySignature(decoded, opts.key, keyEncoding);
  const vf = VERDICT[verification.code];
  result.verification = {
    status: verification.status, // verified / failed / error / skipped
    message: typeof vf === 'function' ? vf(verification.arg) : verification.code,
  };
  if (verification.status === 'verified' && decoded.header && /^HS(256|384|512)$/.test(String(decoded.header.alg))) {
    const need = { HS256: 32, HS384: 48, HS512: 64 }[decoded.header.alg];
    let len = need;
    try {
      len = secretToBytes(String(opts.key).trim(), keyEncoding).length;
    } catch (e) {
      len = need;
    }
    if (len < need) result.verification.warning = VERDICT.short_secret();
  }

  // 署名を検証できたあとに「検証していません」と出し続けない（site 側 renderNotes と同じ）
  const shown = verification.status === 'verified'
    ? warnings.filter((w) => w.code !== 'not_verified')
    : warnings;
  result.warnings = shown.map((w) => warnText(w));
  return result;
}
