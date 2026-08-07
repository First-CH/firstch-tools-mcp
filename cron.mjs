/* Cron式の解説＋次回発火日時（cron_explain）
 * アルゴリズムは FirstCHTools の site/cron/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 *
 * 解釈は Vixie cron（crontab(5)）準拠。5フィールド（分 時 日 月 曜日）を基本とし、
 * 6フィールドのときは先頭を秒として扱う（node-cron / Spring 形式）。
 * 「日」と「曜日」の両方が指定されたときは AND ではなく OR（どちらかに一致すれば実行）。
 * 次回発火はタイムゾーンの壁時計（wall clock）上で探索し、見つかった壁時計を
 * 実時刻へ戻してから表示用に再フォーマットする（DSTのある地域でも嘘をつかないため）。 */

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_ALIASES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_ALIASES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// dow は解析中だけ 0-7 を許し（7=日曜）、展開後に 7→0 へ正規化する。
// こうすると 0-7 や 1-7 のような「7を終端に使う書き方」が素直に全曜日になる。
const DEFS = {
  second: { key: 'second', min: 0, max: 59 },
  minute: { key: 'minute', min: 0, max: 59 },
  hour: { key: 'hour', min: 0, max: 23 },
  dom: { key: 'dom', min: 1, max: 31 },
  month: { key: 'month', min: 1, max: 12, aliases: MONTH_ALIASES, aliasBase: 1, wrap: true },
  dow: { key: 'dow', min: 0, max: 7, aliases: DOW_ALIASES, aliasBase: 0, wrap: true, normalize: true },
};

export class CronError extends Error {
  constructor(code, params) {
    super(code);
    this.code = code;
    this.params = params || {};
    this.message = formatError(this);
  }
}

const FIELD_JA = { second: '秒', minute: '分', hour: '時', dom: '日', month: '月', dow: '曜日' };
const FIELD_EN = { second: 'second', minute: 'minute', hour: 'hour', dom: 'day of month', month: 'month', dow: 'day of week' };

const ERR_JA = {
  empty: () => 'Cron式が空です。',
  bad_arity: (q) => `Cron式は5フィールド（分 時 日 月 曜日）、秒を付ける場合は6フィールドです（入力は ${q.count} フィールド）。`,
  bad_macro: (q) => `未対応の省略記法 ${q.token} です。使えるのは @yearly @annually @monthly @weekly @daily @midnight @hourly です。`,
  reboot: () => '@reboot は「起動時に1回」で、日時が決まらないため次回発火は計算できません。',
  empty_field: (q) => `${FIELD_JA[q.field]}のフィールドが空です。`,
  bad_token: (q) => `${FIELD_JA[q.field]}のフィールドの "${q.token}" が解釈できません。`,
  bad_step: (q) => `${FIELD_JA[q.field]}の "${q.token}" のステップ（/ のうしろ）は1以上の整数にしてください。`,
  out_of_range: (q) => `"${q.token}" は${FIELD_JA[q.field]}の範囲（${q.min}〜${q.max}）の外です。`,
  bad_range: (q) => `${FIELD_JA[q.field]}の "${q.token}" は範囲の向きが逆です。小さい方から大きい方へ書いてください（折り返しが使えるのは月と曜日だけです）。`,
  unsupported_ext: (q) => `"${q.token}" は Quartz 拡張（L / W / #）です。このツールは標準のUnix cron準拠のため対応していません。`,
};

const ERR_EN = {
  empty: () => 'The cron expression is empty.',
  bad_arity: (q) => `A cron expression needs 5 fields (minute hour day month weekday), or 6 with a leading seconds field — got ${q.count}.`,
  bad_macro: (q) => `Unknown shorthand ${q.token}. Supported: @yearly @annually @monthly @weekly @daily @midnight @hourly.`,
  reboot: () => '@reboot fires when the machine (or the daemon) starts, so it has no scheduled date and time.',
  empty_field: (q) => `The ${FIELD_EN[q.field]} field is empty.`,
  bad_token: (q) => `Cannot read "${q.token}" in the ${FIELD_EN[q.field]} field.`,
  bad_step: (q) => `The step in "${q.token}" (${FIELD_EN[q.field]}) must be an integer of 1 or more.`,
  out_of_range: (q) => `"${q.token}" is outside the ${FIELD_EN[q.field]} range (${q.min}-${q.max}).`,
  bad_range: (q) => `"${q.token}" (${FIELD_EN[q.field]}) counts down; a range must go from smaller to larger. Wrap-around is only allowed for month and weekday.`,
  unsupported_ext: (q) => `"${q.token}" is a Quartz extension (L / W / #). This tool follows standard Unix cron and does not support it.`,
};

/** 例外メッセージは日英併記（呼び出し側の言語が分からないため） */
export function formatError(err) {
  const ja = (ERR_JA[err.code] || (() => 'この式は解釈できませんでした。'))(err.params);
  const en = (ERR_EN[err.code] || (() => 'Could not parse this expression.'))(err.params);
  return `${ja} / ${en}`;
}

/** 単一の値トークン（数値 or JAN/SUN 等の別名）を数値へ解決する */
function resolveValue(tok, def) {
  const t = String(tok).trim();
  if (!t) throw new CronError('bad_token', { field: def.key, token: tok });
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (n < def.min || n > def.max) {
      throw new CronError('out_of_range', { field: def.key, token: t, min: def.min, max: def.max });
    }
    return n;
  }
  if (def.aliases) {
    const i = def.aliases.indexOf(t.toUpperCase());
    if (i >= 0) return i + def.aliasBase;
  }
  // Quartz拡張（L / W / #）はこのツールでは扱わない。誤って通さず、はっきり伝える
  if (/^\d*[LW]$/i.test(t) || t.includes('#')) throw new CronError('unsupported_ext', { field: def.key, token: t });
  throw new CronError('bad_token', { field: def.key, token: t });
}

/**
 * 1フィールドを解析して、一致する値の集合と、書き方の内訳（items）を返す。
 * @returns {{values:number[], set:Set<number>, all:boolean, items:Array}}
 */
function parseField(raw, def) {
  const src = String(raw).trim();
  if (!src) throw new CronError('empty_field', { field: def.key });
  const set = new Set();
  const items = [];
  const N = def.max - def.min + 1;

  for (const part of src.split(',')) {
    const p = part.trim();
    if (!p) throw new CronError('bad_token', { field: def.key, token: part });

    let rangeTxt = p;
    let stepTxt = null;
    const slash = p.indexOf('/');
    if (slash >= 0) {
      rangeTxt = p.slice(0, slash).trim();
      stepTxt = p.slice(slash + 1).trim();
    }
    let step = 1;
    if (stepTxt !== null) {
      if (!/^\d+$/.test(stepTxt) || parseInt(stepTxt, 10) < 1) {
        throw new CronError('bad_step', { field: def.key, token: p });
      }
      step = parseInt(stepTxt, 10);
    }

    let from;
    let to;
    let kind;
    if (rangeTxt === '*' || rangeTxt === '?') {
      from = def.min;
      to = def.max;
      kind = 'all';
    } else {
      const dash = rangeTxt.indexOf('-');
      if (dash >= 0) {
        from = resolveValue(rangeTxt.slice(0, dash), def);
        to = resolveValue(rangeTxt.slice(dash + 1), def);
        kind = 'range';
      } else {
        from = resolveValue(rangeTxt, def);
        // Vixie拡張: `5/10` は「5から最大値まで10おき」
        to = stepTxt !== null ? def.max : from;
        kind = stepTxt !== null ? 'range' : 'single';
      }
    }

    let count;
    if (from <= to) count = to - from + 1;
    else if (def.wrap) count = ((to - from + N) % N) + 1; // 月/曜日だけ NOV-FEB のような折り返しを許す
    else throw new CronError('bad_range', { field: def.key, token: p, from, to });

    for (let k = 0; k < count; k += step) set.add(def.min + ((from - def.min + k) % N));
    items.push({ text: p, kind, from, to, step, wrapped: from > to });
  }

  if (def.normalize) {
    // 曜日の 7 は 0（日曜）と同じ
    if (set.has(7)) {
      set.delete(7);
      set.add(0);
    }
  }
  const effMax = def.normalize ? 6 : def.max;
  const values = [...set].sort((a, b) => a - b);
  return { values, set, all: values.length === effMax - def.min + 1, items, def, effMax };
}

/**
 * Cron式を解析する。5フィールド（分 時 日 月 曜日）または6フィールド（先頭が秒）。
 * @throws {CronError}
 */
export function parseCron(expr) {
  let src = String(expr == null ? '' : expr).trim().replace(/\s+/g, ' ');
  if (!src) throw new CronError('empty');

  let macro = null;
  if (src.startsWith('@')) {
    const key = src.toLowerCase();
    if (key === '@reboot') throw new CronError('reboot');
    if (!Object.prototype.hasOwnProperty.call(MACROS, key)) throw new CronError('bad_macro', { token: src });
    macro = key;
    src = MACROS[key];
  }

  const parts = src.split(' ');
  if (parts.length !== 5 && parts.length !== 6) throw new CronError('bad_arity', { count: parts.length });
  const hasSeconds = parts.length === 6;
  const order = hasSeconds
    ? ['second', 'minute', 'hour', 'dom', 'month', 'dow']
    : ['minute', 'hour', 'dom', 'month', 'dow'];

  const fields = {};
  order.forEach((key, i) => {
    fields[key] = parseField(parts[i], DEFS[key]);
    fields[key].text = parts[i];
  });
  if (!hasSeconds) {
    fields.second = { values: [0], set: new Set([0]), all: false, items: [], def: DEFS.second, effMax: 59, text: '0' };
  }

  const warnings = [];
  if (hasSeconds) warnings.push({ code: 'six_fields' });
  // `*/7` のような「範囲を割り切らないステップ」は、境界で数え直すので等間隔にならない
  for (const key of order) {
    const f = fields[key];
    const d = DEFS[key];
    const span = (d.normalize ? 6 : d.max) - d.min + 1;
    for (const it of f.items) {
      if (it.kind === 'all' && it.step > 1 && span % it.step !== 0) {
        warnings.push({ code: 'uneven_step', field: key, step: it.step, span });
      }
    }
  }
  if (!fields.dom.all && !fields.dow.all) warnings.push({ code: 'dom_dow_or' });

  return {
    expression: expr,
    normalized: order.map((k) => fields[k].text).join(' '),
    macro,
    hasSeconds,
    order,
    fields,
    warnings,
  };
}

/* ---- タイムゾーン付きの壁時計計算 ---- */

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
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** 実時刻(ms) → そのタイムゾーンの壁時計 */
export function tzParts(ms, timeZone) {
  const o = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function tzOffset(ms, timeZone) {
  const p = tzParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** 壁時計 → 実時刻(ms)。オフセットを2回引き直してDSTの境目でもずれないようにする */
function zonedToMs(w, timeZone) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let ms = guess - tzOffset(guess, timeZone);
  ms = guess - tzOffset(ms, timeZone);
  return ms;
}

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dowOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/**
 * 次に発火する時刻を count 件返す（fromより後）。
 * @returns {{fires:number[], exhausted:boolean}} fires は実時刻(ms)の昇順
 */
export function nextFires(parsed, opts) {
  const timeZone = opts.timeZone;
  const count = opts.count || 5;
  const from = opts.from;
  const hasSec = parsed.hasSeconds;

  const sSet = parsed.fields.second.set;
  const miSet = parsed.fields.minute.set;
  const hSet = parsed.fields.hour.set;
  const domSet = parsed.fields.dom.set;
  const moSet = parsed.fields.month.set;
  const dowSet = parsed.fields.dow.set;
  const bothRestricted = !parsed.fields.dom.all && !parsed.fields.dow.all;

  // 「今より後」から探す。分精度なら次の分の0秒から
  const cur = tzParts(from + (hasSec ? 1000 : 60000), timeZone);
  if (!hasSec) cur.s = 0;

  const rollDay = () => {
    cur.d += 1;
    cur.h = 0;
    cur.mi = 0;
    cur.s = 0;
    if (cur.d > daysInMonth(cur.y, cur.mo)) {
      cur.d = 1;
      cur.mo += 1;
      if (cur.mo > 12) {
        cur.mo = 1;
        cur.y += 1;
      }
    }
  };
  const rollMonth = () => {
    cur.mo += 1;
    cur.d = 1;
    cur.h = 0;
    cur.mi = 0;
    cur.s = 0;
    if (cur.mo > 12) {
      cur.mo = 1;
      cur.y += 1;
    }
  };
  const rollHour = () => {
    cur.h += 1;
    cur.mi = 0;
    cur.s = 0;
    if (cur.h > 23) rollDay();
  };
  const rollMinute = () => {
    cur.mi += 1;
    cur.s = 0;
    if (cur.mi > 59) rollHour();
  };
  const rollSecond = () => {
    cur.s += 1;
    if (cur.s > 59) rollMinute();
  };

  const limitYear = cur.y + 6; // 6年探して見つからなければ「発火しない式」とみなす
  const fires = [];
  let prev = -Infinity;
  let guard = 0;
  let exhausted = false;
  let dstSkipped = 0;

  while (fires.length < count) {
    if (cur.y > limitYear || guard++ > 3000000) {
      exhausted = true;
      break;
    }
    if (!moSet.has(cur.mo)) {
      rollMonth();
      continue;
    }
    if (cur.d > daysInMonth(cur.y, cur.mo)) {
      rollDay();
      continue;
    }
    const okDom = domSet.has(cur.d);
    const okDow = dowSet.has(dowOf(cur.y, cur.mo, cur.d));
    const dayOk = bothRestricted ? okDom || okDow : okDom && okDow;
    if (!dayOk) {
      rollDay();
      continue;
    }
    if (!hSet.has(cur.h)) {
      rollHour();
      continue;
    }
    if (!miSet.has(cur.mi)) {
      rollMinute();
      continue;
    }
    if (hasSec && !sSet.has(cur.s)) {
      rollSecond();
      continue;
    }
    const ms = zonedToMs(cur, timeZone);
    // 夏時間の飛びでその壁時計が存在しない日は、戻したときに別の時刻になる。
    // 実行されない時刻を並べても仕方がないので、その回は落とす（cron実装によって挙動が割れる部分）。
    const back = tzParts(ms, timeZone);
    const exists =
      back.y === cur.y && back.mo === cur.mo && back.d === cur.d && back.h === cur.h && back.mi === cur.mi && back.s === cur.s;
    if (!exists) dstSkipped += 1;
    else if (ms > from && ms > prev) {
      fires.push(ms);
      prev = ms;
    }
    if (hasSec) rollSecond();
    else rollMinute();
  }
  return { fires, exhausted, dstSkipped };
}

/* ---- 値の並びを人間向けに縮める ---- */

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JA_UNIT = { second: '秒', minute: '分', hour: '時', dom: '日', month: '月' };

function valueName(v, key, en) {
  if (key === 'dow') return en ? DOW_EN[v] : DOW_JA[v] + '曜';
  if (en) return key === 'month' ? MONTH_EN[v - 1] : String(v);
  return `${v}${JA_UNIT[key] || ''}`;
}

/** [0,1,2,3,7] → 「0〜3, 7」のように、3つ以上続く部分だけ範囲へまとめる */
function compressValues(values, key, en, maxGroups) {
  const cap = maxGroups || 10;
  const groups = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) {
      groups.push(`${valueName(values[i], key, en)}${en ? '–' : '〜'}${valueName(values[j], key, en)}`);
    } else {
      for (let k = i; k <= j; k++) groups.push(valueName(values[k], key, en));
    }
    i = j + 1;
  }
  const sep = en ? ', ' : '・';
  if (groups.length > cap) return groups.slice(0, cap).join(sep) + (en ? ', …' : ' …');
  return groups.join(sep);
}

/** 全値が等間隔で、かつ範囲を割り切るときだけ「Nおき」と言い切れる */
function evenStep(field) {
  const v = field.values;
  const d = field.def;
  if (v.length < 2) return 0;
  const step = v[1] - v[0];
  if (step < 2) return 0;
  for (let i = 2; i < v.length; i++) if (v[i] - v[i - 1] !== step) return 0;
  const span = field.effMax - d.min + 1;
  if (v[0] !== d.min || span % step !== 0 || v.length !== span / step) return 0;
  return step;
}

/* ---- 日本語・英語の読み下し ---- */

function timePhrase(p, en) {
  const h = p.fields.hour;
  const mi = p.fields.minute;
  const s = p.fields.second;
  const pad = (n) => String(n).padStart(2, '0');
  const miStep = evenStep(mi);
  const hStep = evenStep(h);

  const hourList = compressValues(h.values, 'hour', en);
  const minList = compressValues(mi.values, 'minute', en);
  // en は :00, :15 の形で読ませるが、長くなりすぎるものは打ち切る
  const enClock = (vals) =>
    vals.length > 10 ? `:${vals.slice(0, 10).map(pad).join(', :')}, …` : `:${vals.map(pad).join(', :')}`;

  let base;
  if (en) {
    const hourPart = h.all ? 'every hour' : hStep ? `every ${hStep} hours (${hourList})` : `hour ${hourList}`;
    if (h.all && mi.all) base = 'every minute';
    else if (h.all) base = miStep ? `every ${miStep} minutes (at ${enClock(mi.values)})` : `every hour at ${enClock(mi.values)}`;
    else if (mi.all) base = `every minute of ${hourPart}`;
    else if (h.values.length === 1 && mi.values.length === 1) base = `at ${pad(h.values[0])}:${pad(mi.values[0])}`;
    else base = `${hourPart} at ${enClock(mi.values)}`;
  } else {
    const hourPart = h.all ? '毎時' : hStep ? `${hStep}時間ごと（${hourList}）` : hourList;
    if (h.all && mi.all) base = '毎分';
    else if (h.all) base = miStep ? `${miStep}分ごと（毎時 ${minList}）` : `毎時 ${minList}`;
    else if (mi.all) base = `${hourPart}の毎分`;
    else if (h.values.length === 1 && mi.values.length === 1) base = `${h.values[0]}時${pad(mi.values[0])}分`;
    else base = `${hourPart}の${minList}`;
  }

  if (!p.hasSeconds) return base;
  if (s.all) return en ? `${base}, every second` : `${base}の毎秒`;
  const sStep = evenStep(s);
  if (sStep) return en ? `${base} (every ${sStep} seconds)` : `${base}の${sStep}秒ごと`;
  if (en) return `${base} (second ${enClock(s.values)})`;
  return `${base}${compressValues(s.values, 'second', false)}`;
}

function datePhrase(p, en) {
  const dom = p.fields.dom;
  const dow = p.fields.dow;
  const mo = p.fields.month;

  const moPart = mo.all ? null : compressValues(mo.values, 'month', en);
  const domList = compressValues(dom.values, 'dom', en);
  const dowList = compressValues(dow.values, 'dow', en);
  let dayPart;
  if (dom.all && dow.all) dayPart = en ? 'every day' : '毎日';
  else if (!dom.all && dow.all) {
    // 月が絞られていれば「1月1日」、絞られていなければ「毎月1日」
    dayPart = en ? `on day ${domList} of the month` : `${moPart ? '' : '毎月'}${domList}`;
    if (!en && moPart) return `${moPart}${domList}`;
  } else if (dom.all && !dow.all) dayPart = en ? `on ${dowList}` : `毎週${dowList}`;
  else {
    // Cronの仕様: 日と曜日の両方が指定されたときは AND ではなく OR
    dayPart = en
      ? `on day ${domList} of the month, or on ${dowList} (whichever matches)`
      : `毎月${domList} または 毎週${dowList}（どちらかに一致した日）`;
  }
  if (!moPart) return dayPart;
  return en ? `in ${moPart}, ${dayPart}` : `${moPart}の${dayPart}`;
}

/** 「毎日、15分おき（毎時 0分・15分・30分・45分）に実行します。」のような1文を返す */
export function describe(p, en) {
  if (en) return `Runs ${datePhrase(p, true)}, ${timePhrase(p, true)}.`;
  return `${datePhrase(p, false)}、${timePhrase(p, false)}に実行します。`;
}

/* ---- 注意書き ---- */

const WARN_JA = {
  six_fields: () => '6フィールドのため、先頭を「秒」として解釈しました（node-cron / Spring 形式）。標準のUnix crontab は5フィールドです。',
  uneven_step: (q) => `${FIELD_JA[q.field]}の */${q.step} は境界（0）から数え直すため、最後の値と次の0の間だけ間隔が ${q.step} より短くなります。等間隔にはなりません。`,
  dom_dow_or: () => '「日」と「曜日」の両方が指定されています。Cronはこれを AND ではなく OR として扱うため、どちらかに一致した日すべてで実行されます。',
  never: () => '今後6年以内に一致する日時がありませんでした。2月30日のような存在しない組み合わせになっていないか確認してください。',
  limited: (q) => `今後6年以内に見つかったのは ${q.found} 件までです（それより先は探索していません）。`,
  dst_skip: (q) => `夏時間の切り替えで存在しない現地時刻になる回が ${q.count} 件あったため、一覧から除いています（この場合の挙動はcron実装によって異なります）。`,
};

const WARN_EN = {
  six_fields: () => 'Six fields: the first one is read as seconds (node-cron / Spring style). Standard Unix crontab uses five fields.',
  uneven_step: (q) => `*/${q.step} in the ${FIELD_EN[q.field]} field restarts from the beginning of each cycle, so the gap around the boundary is shorter than ${q.step} — the interval is not uniform.`,
  dom_dow_or: () => 'Both "day of month" and "day of week" are restricted. Cron treats this as OR, not AND — it fires on days matching either one.',
  never: () => 'No matching date and time was found within the next six years. Check for impossible combinations such as February 30th.',
  limited: (q) => `Only ${q.found} run time(s) fall within the next six years; the search stops there.`,
  dst_skip: (q) => `${q.count} occurrence(s) fall on local times that do not exist because of a daylight-saving jump and were left out (real cron implementations differ here).`,
};

const warnJa = (w) => (WARN_JA[w.code] || (() => w.code))(w);
const warnEn = (w) => (WARN_EN[w.code] || (() => w.code))(w);

/* ---- 出力の組み立て ---- */

const pad2 = (n) => String(n).padStart(2, '0');
const fmtWall = (w) => `${w.y}-${pad2(w.mo)}-${pad2(w.d)} ${pad2(w.h)}:${pad2(w.mi)}:${pad2(w.s)}`;

/** 実時刻(ms) + タイムゾーン → オフセット付きISO8601（例 2026-08-08T12:15:00+09:00） */
function isoWithOffset(ms, timeZone) {
  const w = tzParts(ms, timeZone);
  const offMin = Math.round(tzOffset(ms, timeZone) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const a = Math.abs(offMin);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}:${pad2(w.s)}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

function humanIn(ms, en) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return en ? 'under a minute' : '1分以内';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const mi = Math.floor((total % 3600) / 60);
  if (en) {
    if (d) return `in ${d}d ${h}h`;
    if (h) return `in ${h}h ${mi}m`;
    return `in ${mi}m`;
  }
  if (d) return `${d}日${h}時間後`;
  if (h) return `${h}時間${mi}分後`;
  return `${mi}分後`;
}

/**
 * Cron式を解説し、次回の発火日時を返す。
 * @param {string} expression Cron式（5フィールド / 6フィールド / @daily 等）
 * @param {{timeZone?:string, count?:number, from?:string|number|Date}} [opts]
 */
export function cronExplain(expression, opts = {}) {
  const timeZone = opts.timeZone || 'UTC';
  const count = Math.min(Math.max(parseInt(opts.count, 10) || 5, 1), 100);
  // タイムゾーン名が不正なら Intl がここで投げる（探索の途中で落とさない）
  try {
    tzParts(Date.now(), timeZone);
  } catch (e) {
    throw new Error(`不明なタイムゾーン "${timeZone}" です（IANA名で指定してください。例: Asia/Tokyo） / Unknown time zone "${timeZone}" (use an IANA name such as Asia/Tokyo)`);
  }
  const fromMs = opts.from === undefined ? Date.now() : new Date(opts.from).getTime();
  if (!Number.isFinite(fromMs)) throw new Error(`from の日時が解釈できません: ${opts.from} / Cannot parse "from": ${opts.from}`);

  const p = parseCron(expression);
  const { fires, exhausted, dstSkipped } = nextFires(p, { from: fromMs, timeZone, count });
  const warnings = p.warnings.slice();
  if (dstSkipped) warnings.push({ code: 'dst_skip', count: dstSkipped });
  if (!fires.length) warnings.push({ code: 'never' });
  else if (exhausted) warnings.push({ code: 'limited', found: fires.length });

  const fieldOut = p.order.map((key) => {
    const f = p.fields[key];
    return {
      field: key,
      label_ja: FIELD_JA[key],
      label_en: FIELD_EN[key],
      expr: f.text,
      values: f.values,
      matches_all: f.all,
      summary_ja: compressValues(f.values, key, false),
      summary_en: compressValues(f.values, key, true),
    };
  });

  return {
    expression: String(expression),
    normalized: p.normalized,
    macro: p.macro,
    has_seconds: p.hasSeconds,
    valid: true,
    description_ja: describe(p, false),
    description_en: describe(p, true),
    fields: fieldOut,
    time_zone: timeZone,
    from: isoWithOffset(fromMs, timeZone),
    next: fires.map((ms) => {
      const w = tzParts(ms, timeZone);
      const wd = dowOf(w.y, w.mo, w.d);
      return {
        iso: isoWithOffset(ms, timeZone),
        local: fmtWall(w),
        epoch_ms: ms,
        weekday_ja: DOW_JA[wd],
        weekday_en: DOW_EN[wd],
        in_ja: humanIn(ms - fromMs, false),
        in_en: humanIn(ms - fromMs, true),
      };
    }),
    never_fires: fires.length === 0,
    warnings_ja: warnings.map(warnJa),
    warnings_en: warnings.map(warnEn),
  };
}
