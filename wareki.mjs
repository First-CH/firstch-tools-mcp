/* 和暦 ⇄ 西暦変換（wareki_convert）
 * 変換コア（wkParse / wkConvert / wkAge / wkEraList / wkYearTable ほか）は
 * FirstCHTools の site/wareki/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 日付は Date を使わず「1970-01-01 からの通算日」の整数で扱うので、
 * サーバーのタイムゾーン設定に結果が左右されない（「今日」だけは日本時間で決める）。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

export class WarekiError extends Error {
  constructor(code, info) {
    super(code);
    this.name = 'WarekiError';
    this.code = code;
    this.info = info || {};
  }
}

/** 明治以降の元号。start / end はグレゴリオ暦の初日・末日（end: null は現在の元号）。
 *  明治の初日は「慶応4年1月1日に遡って明治元年とする」詔（1868年10月23日）に従う。 */
export const WK_ERAS = [
  { key: 'meiji', name: '明治', kana: 'めいじ', en: 'Meiji', abbr: 'M', start: [1868, 1, 25], end: [1912, 7, 29] },
  { key: 'taisho', name: '大正', kana: 'たいしょう', en: 'Taisho', abbr: 'T', start: [1912, 7, 30], end: [1926, 12, 24] },
  { key: 'showa', name: '昭和', kana: 'しょうわ', en: 'Showa', abbr: 'S', start: [1926, 12, 25], end: [1989, 1, 7] },
  { key: 'heisei', name: '平成', kana: 'へいせい', en: 'Heisei', abbr: 'H', start: [1989, 1, 8], end: [2019, 4, 30] },
  { key: 'reiwa', name: '令和', kana: 'れいわ', en: 'Reiwa', abbr: 'R', start: [2019, 5, 1], end: null },
];

export const WK_MIN_YEAR = 1868;
export const WK_MAX_YEAR = 9999;
/** 改暦（明治5年12月3日＝明治6年1月1日）。これより前の和暦の月日は旧暦（天保暦）で、西暦の月日と一致しない */
export const WK_SOLAR_FROM = [1873, 1, 1];

export const WK_WD_JA = ['日', '月', '火', '水', '木', '金', '土'];
export const WK_WD_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WK_MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WK_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
export const WK_STEM_KANA = ['きのえ', 'きのと', 'ひのえ', 'ひのと', 'つちのえ', 'つちのと', 'かのえ', 'かのと', 'みずのえ', 'みずのと'];
export const WK_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
export const WK_BRANCH_KANA = ['ね', 'うし', 'とら', 'う', 'たつ', 'み', 'うま', 'ひつじ', 'さる', 'とり', 'いぬ', 'い'];
export const WK_ANIMAL_JA = ['ねずみ', 'うし', 'とら', 'うさぎ', 'たつ', 'へび', 'うま', 'ひつじ', 'さる', 'とり', 'いぬ', 'いのしし'];
export const WK_ANIMAL_EN = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Boar'];

export function wkIsLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function wkDaysInMonth(y, m) {
  return m === 2 ? (wkIsLeap(y) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** グレゴリオ暦の年月日 → 1970-01-01 からの通算日（Date を使わないのでタイムゾーンで1日ずれない） */
export function wkToDays(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function wkFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: era * 400 + yoe + (m <= 2 ? 1 : 0), m, d };
}

/** 0=日曜 … 6=土曜（1970-01-01 は木曜） */
export function wkWeekday(z) {
  return (((z + 4) % 7) + 7) % 7;
}

export function wkPad(n, w) {
  let s = String(Math.abs(n));
  while (s.length < w) s = '0' + s;
  return (n < 0 ? '-' : '') + s;
}

export function wkIso(y, m, d) {
  return wkPad(y, 4) + '-' + wkPad(m, 2) + '-' + wkPad(d, 2);
}

export function wkIsoFromDays(z) {
  const c = wkFromDays(z);
  return wkIso(c.y, c.m, c.d);
}

const WK_ERA_START = WK_ERAS.map((e) => wkToDays(e.start[0], e.start[1], e.start[2]));
const WK_ERA_END = WK_ERAS.map((e) => (e.end ? wkToDays(e.end[0], e.end[1], e.end[2]) : Infinity));
const WK_SOLAR_Z = wkToDays(WK_SOLAR_FROM[0], WK_SOLAR_FROM[1], WK_SOLAR_FROM[2]);

/** 期間 [fromZ, toZ] に重なる元号を古い順に返す（改元をまたげば2件） */
export function wkErasInRange(fromZ, toZ) {
  const out = [];
  for (let i = 0; i < WK_ERAS.length; i++) {
    if (WK_ERA_START[i] <= toZ && WK_ERA_END[i] >= fromZ) out.push(i);
  }
  return out;
}

/** 和暦の年（元年=1）。明治は1868年を元年とする */
export function wkEraYear(i, y) {
  return y - WK_ERAS[i].start[0] + 1;
}

/** 漢数字（十・百・千の位取り）。0 は〇 */
export function wkKanjiNum(n) {
  const D = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n === 0) return '〇';
  let s = '';
  const units = [[1000, '千'], [100, '百'], [10, '十']];
  let r = n;
  for (const [v, u] of units) {
    const q = Math.floor(r / v);
    if (q) s += (q === 1 ? '' : D[q]) + u;
    r %= v;
  }
  if (r) s += D[r];
  return s;
}

/** 西暦年の漢数字（二〇二六のように1桁ずつ） */
export function wkKanjiDigits(n) {
  return String(n).replace(/[0-9]/g, (c) => '〇一二三四五六七八九'[Number(c)]);
}

/** 漢数字の連なりを整数へ。十百千を含めば位取り、無ければ1桁ずつ（二〇二六） */
export function wkKanjiToInt(s) {
  const D = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (!/[十百千]/.test(s)) {
    let v = 0;
    for (const c of s) v = v * 10 + D[c];
    return v;
  }
  let total = 0;
  let cur = 0;
  for (const c of s) {
    if (c in D) cur = D[c];
    else {
      const u = c === '十' ? 10 : c === '百' ? 100 : 1000;
      total += (cur || 1) * u;
      cur = 0;
    }
  }
  return total + cur;
}

/** 干支（十干十二支）。1984年＝甲子を起点にした暦年の干支で、立春・旧正月での切り替えはしない */
export function wkEto(y) {
  const i = (((y - 1984) % 60) + 60) % 60;
  const s = i % 10;
  const b = i % 12;
  return {
    kanji: WK_STEMS[s] + WK_BRANCHES[b],
    kana: WK_STEM_KANA[s] + WK_BRANCH_KANA[b],
    branch: WK_BRANCHES[b],
    animal_ja: WK_ANIMAL_JA[b],
    animal_en: WK_ANIMAL_EN[b],
  };
}

const WK_ERA_WORDS = [
  [/^(明治|明|m|meiji)$/i, 0],
  [/^(大正|大|t|taisho|taishou|taishō)$/i, 1],
  [/^(昭和|昭|s|showa|shouwa|shōwa)$/i, 2],
  [/^(平成|平|h|heisei)$/i, 3],
  [/^(令和|令|r|reiwa)$/i, 4],
];

/**
 * 日付の文字列を読む。西暦（2026-10-01 / 2026/10/1 / 20261001 / 2026年10月1日 / 2026年 / 2026-10）と
 * 和暦（令和8年10月1日 / R8.10.1 / 平成元年 / 令和八年十月一日 / ㋿8.10.1 / Reiwa 8）を受け付ける。
 * 返り値の precision は 'year' | 'month' | 'day'。曜日の書き添え（（木）・木曜日・(Thu)）は取り出して weekday に入れる。
 */
export function wkParse(input) {
  const raw = String(input === undefined || input === null ? '' : input);
  let s = raw.normalize('NFKC').trim();
  if (!s) throw new WarekiError('EMPTY', {});
  // 曜日の書き添え
  let weekday = null;
  const WDJ = '日月火水木金土';
  const WDE = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  s = s.replace(/[(（]\s*([日月火水木金土]|sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s*(?:曜日?)?\s*[)）]/i, (_, w) => {
    weekday = WDJ.indexOf(w) >= 0 ? WDJ.indexOf(w) : WDE.indexOf(w.slice(0, 3).toLowerCase());
    return ' ';
  });
  s = s.replace(/([日月火水木金土])曜日?\s*$/, (_, w) => {
    weekday = WDJ.indexOf(w);
    return '';
  });
  s = s.replace(/,?\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s*$/i, (_, w) => {
    weekday = WDE.indexOf(w.slice(0, 3).toLowerCase());
    return '';
  });
  // 添え書き（生まれ・付・現在）と「西暦」
  s = s.replace(/\s*(生まれ|生|付け?|現在|時点|まで|より|から)\s*$/, '');
  s = s.replace(/^\s*(西暦|AD|A\.D\.)\s*/i, '');
  // 元年・漢数字
  s = s.replace(/元(?=\s*年)/g, '1');
  s = s.replace(/[〇零一二三四五六七八九十百千]+/g, (m) => String(wkKanjiToInt(m)));
  s = s.replace(/\s+/g, '');
  if (!s) throw new WarekiError('EMPTY', {});

  const SEP = '[年./\\-]';
  const tail = `(?:${SEP}(?:(\\d{1,2})(?:(?:月|[./\\-])(?:(\\d{1,2})日?)?)?)?)?`;
  const wm = new RegExp(`^([^\\d]+?)\\.?(\\d{1,4})${tail}$`).exec(s);
  if (wm && !/^\d/.test(s)) {
    let era = -1;
    for (const [re, i] of WK_ERA_WORDS) if (re.test(wm[1])) era = i;
    if (era < 0) throw new WarekiError('UNKNOWN_ERA', { era: wm[1] });
    return finishParse(raw, 'wareki', era, Number(wm[2]), wm[3], wm[4], weekday);
  }
  let gm = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (gm) return finishParse(raw, 'seireki', -1, Number(gm[1]), gm[2], gm[3], weekday);
  gm = new RegExp(`^(\\d{4})${tail}$`).exec(s);
  if (gm) return finishParse(raw, 'seireki', -1, Number(gm[1]), gm[2], gm[3], weekday);
  if (/^\d{1,3}(?:[年./\-]|$)/.test(s)) throw new WarekiError('NEED_ERA', { text: raw.trim() });
  throw new WarekiError('UNREADABLE', { text: raw.trim() });
}

function finishParse(raw, source, era, year, mStr, dStr, weekday) {
  const month = mStr === undefined ? null : Number(mStr);
  const day = dStr === undefined ? null : Number(dStr);
  const precision = day !== null ? 'day' : month !== null ? 'month' : 'year';
  if (source === 'wareki' && year < 1) throw new WarekiError('ERA_YEAR_ZERO', { era: WK_ERAS[era].name });
  const gy = source === 'wareki' ? WK_ERAS[era].start[0] + year - 1 : year;
  if (gy < WK_MIN_YEAR || gy > WK_MAX_YEAR) throw new WarekiError('OUT_OF_RANGE', { year: gy });
  if (month !== null && (month < 1 || month > 12)) throw new WarekiError('NO_SUCH_DATE', { year: gy, month, day });
  if (day !== null && (day < 1 || day > wkDaysInMonth(gy, month))) throw new WarekiError('NO_SUCH_DATE', { year: gy, month, day });
  return { text: raw.trim(), source, era, eraYear: source === 'wareki' ? year : null, year: gy, month, day, precision, weekday };
}

function wkWarekiEntry(i, y, m, d, precision, fromZ, toZ) {
  const e = WK_ERAS[i];
  const n = wkEraYear(i, y);
  const ny = n === 1 ? '元' : String(n);
  const ky = n === 1 ? '元' : wkKanjiNum(n);
  const p2 = (v) => wkPad(v, 2);
  let full = `${e.name}${ny}年`;
  let kanji = `${e.name}${ky}年`;
  let abbr = `${e.abbr}${n}`;
  let abbrPad = `${e.abbr}${p2(n)}`;
  let en = `${e.en} ${n} (${y})`;
  if (precision !== 'year') {
    full += `${m}月`;
    kanji += `${wkKanjiNum(m)}月`;
    abbr += `.${m}`;
    abbrPad += `.${p2(m)}`;
    en = `${WK_MONTH_EN[m - 1]}, ${e.en} ${n} (${y})`;
  }
  if (precision === 'day') {
    full += `${d}日`;
    kanji += `${wkKanjiNum(d)}日`;
    abbr += `.${d}`;
    abbrPad += `.${p2(d)}`;
    en = `${WK_MONTH_EN[m - 1]} ${d}, ${e.en} ${n} (${y})`;
  }
  const out = {
    era: e.name,
    era_en: e.en,
    abbr: e.abbr,
    year: n,
    formats: { full, kanji, abbr, abbr_pad: abbrPad, en },
    from: wkIsoFromDays(Math.max(fromZ, WK_ERA_START[i])),
    to: wkIsoFromDays(Math.min(toZ, WK_ERA_END[i])),
  };
  if (precision === 'day') out.formats.full_wd = `${full}（${WK_WD_JA[wkWeekday(fromZ)]}）`;
  return out;
}

function wkSeirekiFormats(y, m, d, precision, z) {
  if (precision === 'year') {
    return { ja: `${y}年`, iso: String(y), slash: String(y), kanji: `${wkKanjiDigits(y)}年`, en: String(y) };
  }
  if (precision === 'month') {
    return {
      ja: `${y}年${m}月`,
      iso: `${y}-${wkPad(m, 2)}`,
      slash: `${y}/${wkPad(m, 2)}`,
      kanji: `${wkKanjiDigits(y)}年${wkKanjiNum(m)}月`,
      en: `${WK_MONTH_EN[m - 1]} ${y}`,
    };
  }
  const wd = wkWeekday(z);
  return {
    ja: `${y}年${m}月${d}日`,
    ja_wd: `${y}年${m}月${d}日（${WK_WD_JA[wd]}）`,
    iso: wkIso(y, m, d),
    slash: `${y}/${wkPad(m, 2)}/${wkPad(d, 2)}`,
    kanji: `${wkKanjiDigits(y)}年${wkKanjiNum(m)}月${wkKanjiNum(d)}日`,
    en: `${WK_WD_EN[wd]}, ${WK_MONTH_EN[m - 1]} ${d}, ${y}`,
  };
}

/** 読んだ日付（wkParse の返り値）を和暦・西暦の両方へ展開する */
export function wkConvert(p) {
  const warnings = [];
  let precision = p.precision;
  const { year: y } = p;
  let m = p.month;
  let d = p.day;
  // 改暦前（1872年以前）の月日は旧暦なので、年単位に落として換算する
  const beforeSolar = y < WK_SOLAR_FROM[0];
  if (beforeSolar && precision !== 'year') {
    warnings.push({ code: 'LUNAR_CALENDAR', source: p.source });
    precision = 'year';
    m = null;
    d = null;
  }
  let fromZ;
  let toZ;
  if (precision === 'year') {
    fromZ = wkToDays(y, 1, 1);
    toZ = wkToDays(y, 12, 31);
  } else if (precision === 'month') {
    fromZ = wkToDays(y, m, 1);
    toZ = wkToDays(y, m, wkDaysInMonth(y, m));
  } else {
    fromZ = wkToDays(y, m, d);
    toZ = fromZ;
  }
  const idx = wkErasInRange(fromZ, toZ);
  const wareki = idx.map((i) => wkWarekiEntry(i, y, m, d, precision, fromZ, toZ));
  if (p.source === 'wareki') {
    const e = WK_ERAS[p.era];
    const given = `${e.name}${p.eraYear === 1 ? '元' : p.eraYear}年` + (p.precision !== 'year' ? `${p.month}月` : '') + (p.precision === 'day' ? `${p.day}日` : '');
    if (idx.indexOf(p.era) < 0) {
      warnings.push({
        code: fromZ < WK_ERA_START[p.era] ? 'ERA_NOT_STARTED' : 'ERA_ENDED',
        given,
        era: e.name,
        era_en: e.en,
        start: wkIso(e.start[0], e.start[1], e.start[2]),
        end: e.end ? wkIso(e.end[0], e.end[1], e.end[2]) : null,
        correct: wareki.map((w) => w.formats.full),
        correct_en: wareki.map((w) => w.formats.en),
      });
    }
  }
  if (precision === 'day' && p.weekday !== null && p.weekday !== undefined && p.weekday !== wkWeekday(fromZ)) {
    warnings.push({ code: 'WEEKDAY_MISMATCH', given: p.weekday, actual: wkWeekday(fromZ) });
  }
  if (wareki.length > 1) warnings.push({ code: 'ERA_BOUNDARY', eras: wareki.map((w) => w.era) });
  const out = {
    input: p.text,
    source: p.source,
    precision,
    seireki: { year: y, month: m, day: d, formats: wkSeirekiFormats(y, m, d, precision, fromZ) },
    wareki,
    eto: wkEto(y),
    warnings,
  };
  if (precision === 'day') {
    out.seireki.iso = wkIso(y, m, d);
    out.weekday = wkWeekday(fromZ);
  }
  return out;
}

/** 誕生日の「その年の該当日」。2月29日生まれは平年だと該当日が無いので3月1日（年齢計算ニ関スル法律・民法143条） */
function wkAnniversary(by, bm, bd, n) {
  const y = by + n;
  if (bd > wkDaysInMonth(y, bm)) return wkToDays(y, bm, wkDaysInMonth(y, bm)) + 1;
  return wkToDays(y, bm, bd);
}

/** 月を足した該当日。該当日が無ければ翌月1日（月末日の満了の翌日） */
function wkAddMonthsLegal(y, m, d, n) {
  const t = (m - 1) + n;
  const yy = y + Math.floor(t / 12);
  const mm = ((t % 12) + 12) % 12 + 1;
  if (d > wkDaysInMonth(yy, mm)) return wkToDays(yy, mm, wkDaysInMonth(yy, mm)) + 1;
  return wkToDays(yy, mm, d);
}

/** 満年齢と数え年・次の誕生日・学歴の年（6-3-3-4制を浪人・留年なしで進んだ場合） */
export function wkAge(birth, ref) {
  if (birth.precision !== 'day') throw new WarekiError('NEED_FULL_DATE', { field: 'birth' });
  if (ref.precision !== 'day') throw new WarekiError('NEED_FULL_DATE', { field: 'reference' });
  if (birth.year < WK_SOLAR_FROM[0]) throw new WarekiError('LUNAR_BIRTH', {});
  const bz = wkToDays(birth.year, birth.month, birth.day);
  const rz = wkToDays(ref.year, ref.month, ref.day);
  if (rz < bz) throw new WarekiError('REF_BEFORE_BIRTH', { birth: wkIsoFromDays(bz), reference: wkIsoFromDays(rz) });
  const { year: by, month: bm, day: bd } = birth;
  let age = ref.year - by;
  if (wkAnniversary(by, bm, bd, age) > rz) age -= 1;
  const lastZ = wkAnniversary(by, bm, bd, age);
  const lc = wkFromDays(lastZ);
  let months = 0;
  while (months < 12 && wkAddMonthsLegal(lc.y, lc.m, lc.d, months + 1) <= rz) months += 1;
  const days = rz - wkAddMonthsLegal(lc.y, lc.m, lc.d, months);
  const nextZ = wkAnniversary(by, bm, bd, age + 1);
  const isBirthday = lastZ === rz;
  // 4月2日〜翌年4月1日生まれが同じ学年（満6歳に達した日の翌日以後の最初の4月に小学校へ入る）
  const cohort = bm > 4 || (bm === 4 && bd >= 2) ? by : by - 1;
  const school = [
    ['elementary_in', cohort + 7, 4],
    ['elementary_out', cohort + 13, 3],
    ['junior_in', cohort + 13, 4],
    ['junior_out', cohort + 16, 3],
    ['high_in', cohort + 16, 4],
    ['high_out', cohort + 19, 3],
    ['univ_in', cohort + 19, 4],
    ['univ_out', cohort + 23, 3],
  ].map(([key, y, m]) => {
    const fz = wkToDays(y, m, 1);
    const i = wkErasInRange(fz, fz)[0];
    const n = wkEraYear(i, y);
    return { key, year: y, month: m, seireki: `${y}年${m}月`, wareki: `${WK_ERAS[i].name}${n === 1 ? '元' : n}年${m}月` };
  });
  return {
    birth: wkConvert(birth),
    reference: wkIso(ref.year, ref.month, ref.day),
    age,
    months,
    days,
    kazoe: ref.year - by + 1,
    days_lived: rz - bz,
    is_birthday: isBirthday,
    next_birthday: { date: wkIsoFromDays(nextZ), age: age + 1, days_until: nextZ - rz, weekday: wkWeekday(nextZ) },
    school_cohort: cohort,
    // 6-3-3制は1947年（昭和22年）の学制改革から。それより前に小学校へ入った世代には当てはまらない
    school: cohort + 7 >= 1947 ? school : null,
  };
}

/** 元号の一覧（ref は期間の年数を数える基準日の通算日） */
export function wkEraList(refZ) {
  return WK_ERAS.map((e, i) => {
    const endZ = Math.min(WK_ERA_END[i], refZ);
    const lastY = wkFromDays(Math.max(endZ, WK_ERA_START[i])).y;
    return {
      era: e.name,
      kana: e.kana,
      era_en: e.en,
      abbr: e.abbr,
      start: wkIso(e.start[0], e.start[1], e.start[2]),
      end: e.end ? wkIso(e.end[0], e.end[1], e.end[2]) : null,
      first_year: e.start[0],
      last_year: e.end ? e.end[0] : null,
      years: e.end ? wkEraYear(i, e.end[0]) : wkEraYear(i, lastY),
      offset: e.start[0] - 1,
      current: !e.end,
    };
  });
}

/** 和暦・西暦の早見表（その年生まれの人の ref 年での満年齢つき）。新しい年が先 */
export function wkYearTable(fromY, toY, refYear) {
  const rows = [];
  for (let y = toY; y >= fromY; y--) {
    const idx = wkErasInRange(wkToDays(y, 1, 1), wkToDays(y, 12, 31));
    const eras = idx.map((i) => {
      const n = wkEraYear(i, y);
      return { era: WK_ERAS[i].name, era_en: WK_ERAS[i].en, abbr: WK_ERAS[i].abbr, year: n, text: `${WK_ERAS[i].name}${n === 1 ? '元' : n}年` };
    });
    const eto = wkEto(y);
    const after = refYear - y;
    rows.push({ year: y, wareki: eras, eto: eto.kanji, animal_ja: eto.animal_ja, animal_en: eto.animal_en, age: after >= 0 ? after : null, age_before_birthday: after - 1 >= 0 ? after - 1 : null });
  }
  return rows;
}

/* ==================== ここまで変換コア ==================== */

/* ---- ここから下はMCP側だけの層（入出力・文言）。site側の app.js には UI 用の同じ文言表がある ---- */

export class WarekiToolError extends Error {}

const WD_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wdLabel = (lang, i) => (lang === 'en' ? WK_WD_EN[i] : WK_WD_JA[i]);

const ERR_JA = {
  EMPTY: () => '日付が空です。',
  UNREADABLE: (i) => `「${i.text}」を日付として読めません。2026-10-01・2026年10月1日・令和8年10月1日・R8.10.1 のように書いてください。`,
  NEED_ERA: (i) => `「${i.text}」は元号が無いため、西暦か和暦かを決められません。和暦なら「令和8年」「R8」のように元号を付け、西暦は4桁で書いてください。`,
  UNKNOWN_ERA: (i) => `「${i.era}」は対応していない元号です（明治・大正・昭和・平成・令和／M・T・S・H・R）。`,
  ERA_YEAR_ZERO: (i) => `${i.era}0年はありません（最初の年は元年＝1年）。`,
  OUT_OF_RANGE: (i) => `${i.year}年は範囲外です（1868年＝明治元年から9999年まで）。`,
  NO_SUCH_DATE: (i) => (i.day === null || i.day === undefined ? `${i.month}月という月はありません。` : `${i.year}年${i.month}月${i.day}日は存在しない日付です。`),
  NEED_FULL_DATE: (i) => `年齢の計算には${i.field === 'birth' ? '生年月日' : '基準日'}を年月日まで入れてください。`,
  LUNAR_BIRTH: () => '1872年（明治5年）以前の生年月日は旧暦のため、満年齢を計算できません。',
  REF_BEFORE_BIRTH: (i) => `基準日（${i.reference}）が生年月日（${i.birth}）より前です。`,
};

const ERR_EN = {
  EMPTY: () => 'The date is empty.',
  UNREADABLE: (i) => `"${i.text}" could not be read as a date. Write it like 2026-10-01, 令和8年10月1日 or R8.10.1.`,
  NEED_ERA: (i) => `"${i.text}" has no era name, so it is unclear whether it is a Western or a Japanese year. Add the era (Reiwa 8, R8) or write the Western year with four digits.`,
  UNKNOWN_ERA: (i) => `"${i.era}" is not a supported era (Meiji, Taisho, Showa, Heisei, Reiwa / M, T, S, H, R).`,
  ERA_YEAR_ZERO: (i) => `There is no year 0 of ${i.era} (the first year is gannen = year 1).`,
  OUT_OF_RANGE: (i) => `The year ${i.year} is out of range (1868 = Meiji 1 to 9999).`,
  NO_SUCH_DATE: (i) => (i.day === null || i.day === undefined ? `There is no month ${i.month}.` : `${i.year}-${i.month}-${i.day} does not exist.`),
  NEED_FULL_DATE: (i) => `The age calculation needs a full ${i.field === 'birth' ? 'date of birth' : 'reference date'} (year, month and day).`,
  LUNAR_BIRTH: () => 'Birth dates in 1872 (Meiji 5) or earlier use the old lunisolar calendar, so the age cannot be worked out.',
  REF_BEFORE_BIRTH: (i) => `The reference date (${i.reference}) is before the date of birth (${i.birth}).`,
};

const ERA_EN = Object.fromEntries(WK_ERAS.map((e) => [e.name, e.en]));

const WARN_JA = {
  LUNAR_CALENDAR: () => '明治5年（1872年）以前は旧暦（天保暦）で、月日が西暦と一致しません。年だけで換算しました（旧暦の年末は西暦では翌年の1〜2月にあたります）。',
  ERA_NOT_STARTED: (w) => `${w.given}は${w.era}の始まり（${w.start}）より前の日付です。この日の正しい和暦は ${w.correct.join('／')} です。`,
  ERA_ENDED: (w) => `${w.given}は${w.era}の終わり（${w.end}）より後の日付です。正しい和暦は ${w.correct.join('／')} です。`,
  WEEKDAY_MISMATCH: (w) => `書き添えの曜日（${WK_WD_JA[w.given]}）が実際の曜日（${WK_WD_JA[w.actual]}）と違います。`,
  ERA_BOUNDARY: (w) => `この期間の途中で改元しています（${w.eras.join('→')}）。日付まで入れると1つに決まります。`,
};

const WARN_EN = {
  LUNAR_CALENDAR: () => 'Before 1873 (Meiji 5 and earlier) Japan used the lunisolar calendar, so months and days do not match the Western calendar. Converted by year only (the end of a lunar year falls in January or February of the next Western year).',
  ERA_NOT_STARTED: (w) => `${w.given} is before ${w.era_en} began (${w.start}). The correct Japanese date is ${w.correct_en.join(' / ')} (${w.correct.join(' / ')}).`,
  ERA_ENDED: (w) => `${w.given} is after ${w.era_en} ended (${w.end}). The correct Japanese date is ${w.correct_en.join(' / ')} (${w.correct.join(' / ')}).`,
  WEEKDAY_MISMATCH: (w) => `The weekday written with the date (${WD_SHORT_EN[w.given]}) does not match the actual weekday (${WD_SHORT_EN[w.actual]}).`,
  ERA_BOUNDARY: (w) => `The era changed during this period (${w.eras.map((e) => ERA_EN[e] || e).join(' → ')}). Give the full date to get a single answer.`,
};

const SCHOOL_JA = {
  elementary_in: '小学校入学', elementary_out: '小学校卒業', junior_in: '中学校入学', junior_out: '中学校卒業',
  high_in: '高等学校入学', high_out: '高等学校卒業', univ_in: '大学入学', univ_out: '大学卒業（4年制）',
};
const SCHOOL_EN = {
  elementary_in: 'Elementary school entry', elementary_out: 'Elementary school graduation', junior_in: 'Junior high entry', junior_out: 'Junior high graduation',
  high_in: 'High school entry', high_out: 'High school graduation', univ_in: 'University entry', univ_out: 'University graduation (4 years)',
};

const errText = (lang, code, info) => {
  const table = lang === 'en' ? ERR_EN : ERR_JA;
  return table[code] ? table[code](info || {}) : code;
};
const warnText = (lang, w) => {
  const table = lang === 'en' ? WARN_EN : WARN_JA;
  return { code: w.code, message: table[w.code] ? table[w.code](w) : w.code };
};

/** 日本時間の今日（MCPサーバーのタイムゾーンに左右されない） */
function todayJst() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;
}

/** wkConvert の結果に曜日・干支の表示名と指摘の文言を足す */
function shapeConvert(r, lang) {
  const out = {
    ok: true,
    input: r.input,
    detected: r.source,
    precision: r.precision,
    seireki: r.seireki,
    wareki: r.wareki,
    eto: { kanji: r.eto.kanji, kana: r.eto.kana, animal: lang === 'en' ? r.eto.animal_en : r.eto.animal_ja },
  };
  if (r.weekday !== undefined) {
    out.weekday = wdLabel(lang, r.weekday);
    out.weekday_index = r.weekday;
  }
  if (r.warnings.length) out.notes = r.warnings.map((w) => warnText(lang, w));
  return out;
}

function convertOne(text, lang) {
  try {
    return shapeConvert(wkConvert(wkParse(text)), lang);
  } catch (err) {
    if (!(err instanceof WarekiError)) throw err;
    // 日付の書き方の誤りは「呼び出し方の誤り」ではないので、例外ではなく結果として返す
    return { ok: false, input: String(text), error: { code: err.code, message: errText(lang, err.code, err.info) } };
  }
}

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const MAX_DATES = 1000;
const MAX_TABLE_ROWS = 500;

/**
 * MCPツール wareki_convert の本体。和暦⇄西暦の変換（1件／一括）・満年齢・元号一覧と早見表の3つを受ける。
 * 計算そのものは変換コア（site版と同一）に任せ、ここは入出力と文言だけを持つ。
 */
export async function warekiConvertTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new WarekiToolError(`lang は ja か en: ${o.lang}`);
  let mode = o.mode;
  if (mode === undefined) mode = hasText(o.birth) ? 'age' : hasText(o.date) || Array.isArray(o.dates) ? 'convert' : 'eras';
  if (mode !== 'convert' && mode !== 'age' && mode !== 'eras') {
    throw new WarekiToolError(`mode は convert / age / eras のどれかです: ${o.mode}`);
  }

  if (mode === 'convert') {
    if (Array.isArray(o.dates)) {
      if (o.dates.length === 0) throw new WarekiToolError('dates が空です');
      if (o.dates.length > MAX_DATES) throw new WarekiToolError(`dates は ${MAX_DATES} 件までです（${o.dates.length} 件）`);
      const results = o.dates.map((d) => convertOne(d, lang));
      return { ok: results.every((r) => r.ok), mode, count: results.length, errors: results.filter((r) => !r.ok).length, results };
    }
    if (!hasText(o.date)) throw new WarekiToolError('mode=convert には date（または dates）が要ります');
    return Object.assign({ mode }, convertOne(o.date, lang));
  }

  if (mode === 'age') {
    if (!hasText(o.birth)) throw new WarekiToolError('mode=age には birth（生年月日）が要ります');
    const refText = hasText(o.reference) ? o.reference : todayJst();
    let r;
    try {
      r = wkAge(wkParse(o.birth), wkParse(refText));
    } catch (err) {
      if (!(err instanceof WarekiError)) throw err;
      return { ok: false, mode, error: { code: err.code, message: errText(lang, err.code, err.info) } };
    }
    const school = lang === 'en' ? SCHOOL_EN : SCHOOL_JA;
    return {
      ok: true,
      mode,
      birth: shapeConvert(r.birth, lang),
      reference: r.reference,
      reference_is_today: !hasText(o.reference),
      age: r.age,
      age_detail: { years: r.age, months: r.months, days: r.days },
      kazoe: r.kazoe,
      days_lived: r.days_lived,
      is_birthday: r.is_birthday,
      next_birthday: Object.assign({}, r.next_birthday, { weekday: wdLabel(lang, r.next_birthday.weekday) }),
      school: r.school ? r.school.map((s) => ({ event: school[s.key], key: s.key, seireki: s.seireki, wareki: s.wareki })) : null,
    };
  }

  // eras
  const refText = hasText(o.reference) ? o.reference : todayJst();
  let ref;
  try {
    ref = wkParse(refText);
  } catch (err) {
    if (!(err instanceof WarekiError)) throw err;
    return { ok: false, mode, error: { code: err.code, message: errText(lang, err.code, err.info) } };
  }
  const refZ = wkToDays(ref.year, ref.month || 12, ref.day || (ref.month ? wkDaysInMonth(ref.year, ref.month) : 31));
  const out = { ok: true, mode, reference: wkIsoFromDays(refZ), eras: wkEraList(refZ) };
  if (o.from_year !== undefined || o.to_year !== undefined) {
    const from = o.from_year === undefined ? WK_MIN_YEAR : o.from_year;
    const to = o.to_year === undefined ? ref.year : o.to_year;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < WK_MIN_YEAR || to > WK_MAX_YEAR || from > to) {
      throw new WarekiToolError(`from_year / to_year は ${WK_MIN_YEAR}〜${WK_MAX_YEAR} の整数で from_year <= to_year: ${from}, ${to}`);
    }
    if (to - from + 1 > MAX_TABLE_ROWS) throw new WarekiToolError(`早見表は ${MAX_TABLE_ROWS} 年分までです（${to - from + 1} 年分）`);
    out.age_reference_year = ref.year;
    out.year_table = wkYearTable(from, to, ref.year).map((row) => ({
      year: row.year,
      wareki: row.wareki.map((w) => (lang === 'en' ? `${w.era_en} ${w.year}` : w.text)).join(' / '),
      eto: row.eto,
      animal: lang === 'en' ? row.animal_en : row.animal_ja,
      age: row.age,
      age_before_birthday: row.age_before_birthday,
    }));
  }
  return out;
}
