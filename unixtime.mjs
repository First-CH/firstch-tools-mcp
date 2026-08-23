/* UNIXタイムスタンプ⇄日時変換（unixtime_convert）
 * アルゴリズムは FirstCHTools の site/unixtime/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 下の「変換コア」は site 側からそのまま持ってきたもので、両ファイルから
 * コアの開始/終了コメントに挟まれた範囲を sed で切り出し（site側は字下げ2文字を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 数値は桁数から単位を推定し（10桁まで秒 / 13桁までミリ秒 / 16桁までマイクロ秒 / それ以上ナノ秒）、
 * 日時側は ISO 8601・`YYYY/M/D H:mm`・和文表記・HTTP-date・`now` を受け付ける。
 * オフセットを持たない日時は指定タイムゾーンの壁時計として解釈し、その旨を notes で返す。 */

/* ==== ここから変換コア（site / MCP で同一） ==== */

const MAX_MS = 8.64e15; // ECMAScript の Date が表せる範囲（±約27万年）
const MAX_ROWS = 500;

const UNIT_LABEL = {
  s: { ja: 'UNIX秒', en: 'Unix seconds' },
  ms: { ja: 'UNIXミリ秒', en: 'Unix milliseconds' },
  us: { ja: 'UNIXマイクロ秒', en: 'Unix microseconds' },
  ns: { ja: 'UNIXナノ秒', en: 'Unix nanoseconds' },
};
const KIND_LABEL = {
  iso: { ja: 'ISO 8601', en: 'ISO 8601' },
  datetime: { ja: '日時文字列', en: 'Date & time' },
  now: { ja: '現在時刻', en: 'Current time' },
};
const ERROR_TEXT = {
  unparsable: {
    ja: '数値としても日時としても読めません。',
    en: 'Not readable as a number or a date.',
  },
  range: {
    ja: '扱える範囲（西暦±27万年ほど）を超えています。単位の指定が合っているか確認してください。',
    en: 'Outside the range a date can represent (about ±270,000 years). Check that the unit is right.',
  },
  invalidDate: {
    ja: '存在しない日付・時刻です。',
    en: 'That date or time does not exist.',
  },
  badZone: {
    ja: 'タイムゾーン名を解決できません。',
    en: 'That time zone name cannot be resolved.',
  },
};
const NOTE_TEXT = {
  truncated: {
    ja: 'ミリ秒より下の桁は切り捨てました。',
    en: 'Digits below the millisecond were dropped.',
  },
  ymdLike: {
    ja: 'YYYYMMDD の日付ではなくUNIX秒として解釈しました（日付として読むなら 2026-08-24 の形で入れてください）。',
    en: 'Read as Unix seconds, not as a YYYYMMDD date (write it as 2026-08-24 to read it as a date).',
  },
  zoneAssumed: {
    ja: 'オフセットが無いため、選択中のタイムゾーンの時刻として解釈しました。',
    en: 'No offset in the input, so it was read as a local time in the selected time zone.',
  },
  dstShift: {
    ja: 'そのタイムゾーンに存在しない時刻（夏時間の切り替え）のため、繰り上げて解釈しました。',
    en: 'That wall-clock time does not exist in this zone (DST change), so it was moved forward.',
  },
  unitForced: {
    ja: '単位の自動判定を使わず、指定された単位で読みました。',
    en: 'Read with the unit you picked instead of auto-detection.',
  },
};

const fmtCache = new Map();
function partsFormatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** 実時刻(ms) → そのタイムゾーンの壁時計 */
function tzParts(ms, timeZone) {
  const o = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  let y = +o.year;
  if (/^B/.test(o.era || '')) y = 1 - y; // 紀元前は 1BC = 0年 として数える
  return { y, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function tzOffset(ms, timeZone) {
  const p = tzParts(ms, timeZone);
  return makeUTC(p.y, p.mo, p.d, p.h, p.mi, p.s, 0) - Math.floor(ms / 1000) * 1000;
}

/** 壁時計 → 実時刻(ms)。オフセットを2回引き直してDSTの境目でもずれないようにする */
function zonedToMs(w, timeZone) {
  const guess = makeUTC(w.y, w.mo, w.d, w.h, w.mi, w.s, 0);
  const first = guess - tzOffset(guess, timeZone);
  const second = guess - tzOffset(first, timeZone);
  // 夏時間で飛ばされて存在しない壁時計は、2回目が切り替え前へ戻ってしまう。
  // その場合は1回目（＝切り替え後へ繰り上げた時刻）を採る。
  const back = tzParts(second, timeZone);
  if (back.h !== w.h || back.mi !== w.mi || back.d !== w.d) return first;
  return second;
}

/** Date.UTC は 0〜99年を1900年代に丸めるため、年は必ず setUTCFullYear で入れ直す */
function makeUTC(y, mo, d, h, mi, s, msPart) {
  const dt = new Date(0);
  dt.setUTCFullYear(2000, mo - 1, d);
  dt.setUTCHours(h, mi, s, msPart);
  dt.setUTCFullYear(y);
  return dt.getTime();
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

const pad = (n, w) => String(Math.abs(n)).padStart(w, '0');
const yearText = (y) => (y < 0 ? '-' + pad(y, 4) : pad(y, 4));
/** その年月の日数。うるう年を年ごとに正しく数えるため、必ず対象の年で計算する */
function daysInMonth(y, mo) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo, 1); // mo は1始まりなので月インデックスとしては翌月
  dt.setUTCHours(0, 0, 0, 0);
  dt.setUTCDate(0); // 前月末日＝対象月の末日
  return dt.getUTCDate();
}

function offsetText(ms, timeZone) {
  const min = Math.round(tzOffset(ms, timeZone) / 60000);
  const sign = min < 0 ? '-' : '+';
  return sign + pad(Math.trunc(Math.abs(min) / 60), 2) + ':' + pad(Math.abs(min) % 60, 2);
}

function dowOf(y, mo, d) {
  return new Date(makeUTC(y, mo, d, 12, 0, 0, 0)).getUTCDay();
}
const DOW = {
  ja: ['日', '月', '火', '水', '木', '金', '土'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

/** BigInt の切り捨て除算（負数でも下方向へ丸める） */
function bigFloorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** 桁数から単位を推定する。10桁までは秒、13桁までミリ秒、16桁までマイクロ秒、それ以上はナノ秒 */
function autoUnit(intStr) {
  const n = intStr.replace(/^0+(?=\d)/, '').length;
  if (n <= 10) return 's';
  if (n <= 13) return 'ms';
  if (n <= 16) return 'us';
  return 'ns';
}

const NUM_RE = /^([+-]?)(\d+)(?:[.,](\d+))?$/;
const DT_RE = /^(\d{1,6})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,9}))?)?(?:\s*(Z|UTC|GMT|[+-]\d{1,2}(?::?\d{2})?))?$/i;
const RFC_RE = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,6})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}))?$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 全角・和文表記をASCIIの日時表記へ寄せる */
function normalizeInput(raw) {
  let s = String(raw)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／：－＋．]/g, (c) => ({ '／': '/', '：': ':', '－': '-', '＋': '+', '．': '.' }[c]))
    .replace(/　/g, ' ')
    .trim();
  // 引用符・括弧・区切りのカンマは、CSVやJSONから貼ったときに前後へ付いてくるので剥がす
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\s"'`[(<]+/, '').replace(/[\s"'`\])>,;]+$/, '');
  } while (s !== prev);
  s = s.replace(/(\d{1,6})年\s*(\d{1,2})月\s*(\d{1,2})日/, '$1-$2-$3');
  s = s.replace(/(\d{1,2})時\s*(\d{1,2})分\s*(?:(\d{1,2})秒)?/, (m, h, mi, sec) => `${h}:${mi}` + (sec ? `:${sec}` : ''));
  s = s.replace(/^@/, '');
  return s.trim();
}

function offsetMinutesOf(spec) {
  if (!spec) return null;
  const t = spec.toUpperCase();
  if (t === 'Z' || t === 'UTC' || t === 'GMT') return 0;
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(t);
  if (!m) return null;
  const v = +m[2] * 60 + (m[3] ? +m[3] : 0);
  return m[1] === '-' ? -v : v;
}

/** 1行を解析して実時刻(ms)にする。読めない行は ok:false で返す */
function parseOne(raw, opts) {
  const timeZone = opts.timeZone;
  const unitOpt = opts.unit || 'auto';
  const notes = [];
  const original = String(raw).trim();
  const s = normalizeInput(raw);
  if (!s) return null;

  const fail = (code) => ({ ok: false, input: original, error: code });

  if (/^(now|today|current|今|いま|現在|現在時刻)$/i.test(s)) {
    return finish(opts.now, 'now', null, notes, original, opts);
  }

  const num = NUM_RE.exec(s);
  if (num) {
    const neg = num[1] === '-';
    const intStr = num[2];
    const frac = num[3] || '';
    const unit = unitOpt === 'auto' ? autoUnit(intStr) : unitOpt;
    if (unitOpt !== 'auto' && unitOpt !== autoUnit(intStr)) notes.push(['unitForced']);
    const sign = neg ? -1n : 1n;
    const big = BigInt(intStr) * sign;
    let msBig;
    let cut = false;
    if (unit === 's') {
      msBig = big * 1000n + sign * BigInt((frac + '000').slice(0, 3));
      if (frac.length > 3 && /[1-9]/.test(frac.slice(3))) cut = true;
    } else if (unit === 'ms') {
      msBig = big;
      if (/[1-9]/.test(frac)) cut = true;
    } else {
      const div = unit === 'us' ? 1000n : 1000000n;
      msBig = bigFloorDiv(big, div);
      if (big % div !== 0n || /[1-9]/.test(frac)) cut = true;
    }
    if (cut) notes.push(['truncated']);
    if (unit === 's' && intStr.length === 8 && looksLikeYmd(intStr)) notes.push(['ymdLike']);
    const ms = Number(msBig);
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return fail('range');
    return finish(ms, unit, unit, notes, original, opts);
  }

  let y;
  let mo;
  let d;
  let h = 0;
  let mi = 0;
  let sec = 0;
  let msPart = 0;
  let offSpec = null;

  const dt = DT_RE.exec(s);
  const rfc = dt ? null : RFC_RE.exec(s);
  if (dt) {
    y = +dt[1];
    mo = +dt[2];
    d = +dt[3];
    h = dt[4] ? +dt[4] : 0;
    mi = dt[5] ? +dt[5] : 0;
    sec = dt[6] ? +dt[6] : 0;
    msPart = dt[7] ? +(dt[7] + '000').slice(0, 3) : 0;
    if (dt[7] && dt[7].length > 3 && /[1-9]/.test(dt[7].slice(3))) notes.push(['truncated']);
    offSpec = dt[8] || null;
  } else if (rfc) {
    const mi3 = MONTHS.indexOf(rfc[2].slice(0, 3).toLowerCase());
    if (mi3 < 0) return fail('unparsable');
    d = +rfc[1];
    mo = mi3 + 1;
    y = +rfc[3];
    if (rfc[3].length === 2) y += y < 70 ? 2000 : 1900;
    h = rfc[4] ? +rfc[4] : 0;
    mi = rfc[5] ? +rfc[5] : 0;
    sec = rfc[6] ? +rfc[6] : 0;
    offSpec = rfc[7] || null;
  } else {
    return fail('unparsable');
  }

  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return fail('invalidDate');
  if (h > 23 || mi > 59 || sec > 60) return fail('invalidDate');
  if (sec === 60) sec = 59; // うるう秒はその分の59秒に寄せる

  let ms;
  if (offSpec) {
    const off = offsetMinutesOf(offSpec);
    if (off === null) return fail('unparsable');
    ms = makeUTC(y, mo, d, h, mi, sec, msPart) - off * 60000;
  } else {
    if (!isValidTimeZone(timeZone)) return fail('badZone');
    ms = zonedToMs({ y, mo, d, h, mi, s: sec }, timeZone) + msPart;
    const back = tzParts(ms, timeZone);
    if (back.h !== h || back.mi !== mi || back.d !== d) notes.push(['dstShift']);
    notes.push(['zoneAssumed']);
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return fail('range');
  return finish(ms, dt && offSpec ? 'iso' : 'datetime', null, notes, original, opts);
}

function looksLikeYmd(intStr) {
  const y = +intStr.slice(0, 4);
  const mo = +intStr.slice(4, 6);
  const d = +intStr.slice(6, 8);
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** 実時刻(ms) から表示用の各表記を組み立てる */
function finish(ms, kind, unit, notes, original, opts) {
  const timeZone = isValidTimeZone(opts.timeZone) ? opts.timeZone : 'UTC';
  const u = tzParts(ms, 'UTC');
  const p = tzParts(ms, timeZone);
  const sub = ((ms % 1000) + 1000) % 1000;
  const frac = sub ? '.' + pad(sub, 3) : '';
  const hms = (q) => `${pad(q.h, 2)}:${pad(q.mi, 2)}:${pad(q.s, 2)}`;
  const ymd = (q) => `${yearText(q.y)}-${pad(q.mo, 2)}-${pad(q.d, 2)}`;
  const off = offsetText(ms, timeZone);
  return {
    ok: true,
    input: original,
    kind,
    unit: unit || null,
    ms,
    seconds: Math.floor(ms / 1000),
    millis: ms,
    iso: `${ymd(u)}T${hms(u)}${frac}Z`,
    isoLocal: `${ymd(p)}T${hms(p)}${frac}${off}`,
    local: `${ymd(p)} ${hms(p)}${frac}`,
    timeZone,
    offset: off,
    dow: dowOf(p.y, p.mo, p.d),
    relativeMs: ms - opts.now,
    notes,
  };
}

/** 相対表示（○分前 / in 3 hours）。基準は opts.now */
function relativeText(diffMs, lang) {
  const future = diffMs > 0;
  const abs = Math.abs(diffMs);
  const ja = lang !== 'en';
  if (abs < 5000) return ja ? 'たった今' : 'just now';
  // [1単位の長さ, その単位を使う上限, 表記]。上限は次の単位ちょうどなので、
  // 365日を「11か月」ではなく「1年」と読ませられる。
  const steps = [
    [1000, 60000, { ja: '秒', en: 'second' }],
    [60000, 3600000, { ja: '分', en: 'minute' }],
    [3600000, 86400000, { ja: '時間', en: 'hour' }],
    [86400000, 2629800000, { ja: '日', en: 'day' }],
    [2629800000, 31536000000, { ja: 'か月', en: 'month' }], // 365日ちょうどで「1年」に切り替える
    [31557600000, Infinity, { ja: '年', en: 'year' }],
  ];
  for (const [size, limit, label] of steps) {
    if (abs < limit) {
      const v = Math.floor(abs / size);
      const n = Math.max(1, v);
      if (ja) return `${n}${label.ja}${future ? '後' : '前'}`;
      const unit = label.en + (n === 1 ? '' : 's');
      return future ? `in ${n} ${unit}` : `${n} ${unit} ago`;
    }
  }
  return ja ? '不明' : 'unknown';
}

function kindLabel(row, lang) {
  const ja = lang !== 'en';
  const t = row.unit ? UNIT_LABEL[row.unit] : KIND_LABEL[row.kind];
  return t ? (ja ? t.ja : t.en) : row.kind;
}

function noteLabel(note, lang) {
  const t = NOTE_TEXT[note[0]];
  return t ? (lang === 'en' ? t.en : t.ja) : note[0];
}

function errorLabel(code, lang) {
  const t = ERROR_TEXT[code];
  return t ? (lang === 'en' ? t.en : t.ja) : code;
}

/**
 * 複数行をまとめて変換する。
 * opts: { timeZone, unit: 'auto'|'s'|'ms'|'us'|'ns', now }
 */
function convertAll(text, opts) {
  const o = {
    timeZone: isValidTimeZone(opts && opts.timeZone) ? opts.timeZone : 'UTC',
    unit: (opts && opts.unit) || 'auto',
    now: opts && Number.isFinite(opts.now) ? opts.now : Date.now(),
  };
  const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
  const rows = [];
  let truncatedRows = false;
  for (const line of lines) {
    if (rows.length >= MAX_ROWS) {
      if (line.trim()) truncatedRows = true;
      continue;
    }
    const r = parseOne(line, o);
    if (r) rows.push(r);
  }
  return {
    timeZone: o.timeZone,
    unit: o.unit,
    now: o.now,
    rows,
    ok: rows.filter((r) => r.ok).length,
    ng: rows.filter((r) => !r.ok).length,
    truncatedRows,
  };
}

/* ==== ここまで変換コア ==== */

export class UnixTimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnixTimeError';
  }
}

const UNITS = ['auto', 's', 'ms', 'us', 'ns'];

/** now は ms の数値か、解釈できる日時文字列を受ける（未指定なら実行時刻） */
function resolveNow(now) {
  if (now === undefined || now === null || now === '') return Date.now();
  if (typeof now === 'number') {
    if (!Number.isFinite(now) || Math.abs(now) > MAX_MS) throw new UnixTimeError(`now が扱える範囲を超えています: ${now}`);
    return now;
  }
  const r = parseOne(String(now), { timeZone: 'UTC', unit: 'auto', now: Date.now() });
  if (!r || !r.ok) throw new UnixTimeError(`now を日時として読めません: ${now}`);
  return r.ms;
}

/**
 * UNIXタイムスタンプと日時表記を相互変換する（tools.first-ch.com/unixtime/ と同一ロジック）。
 *
 * @param {string} input                     1行1件の入力（数値・ISO 8601・日時文字列・now）
 * @param {object} [opts]
 * @param {string} [opts.timeZone='UTC']     現地時刻に使うIANAタイムゾーン名
 * @param {'auto'|'s'|'ms'|'us'|'ns'} [opts.unit='auto'] 数値の単位（既定は桁数からの自動判定）
 * @param {number|string} [opts.now]         相対表示の基準時刻（既定は実行時刻）
 * @param {'ja'|'en'} [opts.lang='ja']       ラベル・相対表示・注記の言語
 * @returns {object}
 */
export function unixtimeConvert(input, opts = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new UnixTimeError('変換する値が空です（1行に1件で渡してください）');
  }
  const timeZone = opts.timeZone === undefined || opts.timeZone === null || opts.timeZone === '' ? 'UTC' : String(opts.timeZone);
  if (!isValidTimeZone(timeZone)) {
    throw new UnixTimeError(`タイムゾーン名を解決できません: ${timeZone}（例: UTC / Asia/Tokyo / America/New_York）`);
  }
  const unit = opts.unit === undefined || opts.unit === null ? 'auto' : String(opts.unit);
  if (UNITS.indexOf(unit) === -1) {
    throw new UnixTimeError(`unit は ${UNITS.join(' / ')} のいずれかを指定してください（受け取った値: ${opts.unit}）`);
  }
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const now = resolveNow(opts.now);

  const res = convertAll(input, { timeZone, unit, now });
  const nowRow = finish(now, 'now', null, [], String(now), { timeZone, now });

  return {
    time_zone: res.timeZone,
    utc_offset: nowRow.offset,
    unit: res.unit,
    now: {
      unix_seconds: nowRow.seconds,
      unix_millis: nowRow.millis,
      iso_utc: nowRow.iso,
      local: `${nowRow.local} (${DOW[lang][nowRow.dow]})`,
    },
    converted: res.ok,
    unreadable: res.ng,
    rows: res.rows.map((r) =>
      r.ok
        ? {
            input: r.input,
            read_as: kindLabel(r, lang),
            unix_seconds: r.seconds,
            unix_millis: r.millis,
            iso_utc: r.iso,
            iso_local: r.isoLocal,
            local: r.local,
            weekday: DOW[lang][r.dow],
            utc_offset: r.offset,
            relative: relativeText(r.relativeMs, lang),
            notes: r.notes.map((n) => ({ code: n[0], message: noteLabel(n, lang) })),
          }
        : { input: r.input, error: { code: r.error, message: errorLabel(r.error, lang) } },
    ),
    truncated: res.truncatedRows ? `先頭 ${MAX_ROWS} 行までを変換しました` : undefined,
  };
}
