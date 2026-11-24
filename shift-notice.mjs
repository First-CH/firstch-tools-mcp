/* 去年の案内文を、今年の日付に直す（shift_notice_dates）
 * 計算のコアは FirstCHTools の site/hizuke/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' site/hizuke/lib.mjs) <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' shift-notice.mjs)
 *
 * 前年の案内文から「日付（曜日）」を抜き出し、1件ずつ前年の日付・移し方（既定は同じ月の同じ第n曜日）・今年の候補・
 * 祝日（内閣府「国民の祝日について」の祝日CSV 1955〜2027年）・注意を返し、指定した行だけ置き換えた文を返す。
 * 完全ローカル処理・ネットワーク送信なし。 */

// ==================== ここからコア ====================
// 去年の案内文の「日付（曜日）」を抜き出し、今年の候補（同じ月の同じ第n曜日など）と祝日・注意を1件ずつ返す。
// 判定は暦の計算と内閣府の祝日の表だけで行い、結果はすべて要確認（置き換えるのは利用者が確定した行だけ）。
// 和暦・六曜・営業日・日付以外の文言（会費・担当者・会場）は扱わない。

// 祝日: 内閣府「国民の祝日について」の syukujitsu.csv（1955〜2027年・1067日）を制作時に取得して写したもの。
// 形: 年ごとに「年」＋「月日4桁＋名前の記号1字」の並び（記号 a, b, … は HOL_NAMES の順）
export const HOLIDAY_SOURCE = Object.freeze({
  name: { ja: '内閣府「国民の祝日について」', en: 'Cabinet Office, Government of Japan: “National Holidays”' },
  url: 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html',
  csv: 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv',
  checked: '2026-11-25',
  from: 1955,
  to: 2027,
});
const HOL_NAMES = [["元日", "New Year's Day"], ["成人の日", "Coming of Age Day"], ["春分の日", "Vernal Equinox Day"], ["天皇誕生日", "The Emperor's Birthday"], ["憲法記念日", "Constitution Memorial Day"], ["こどもの日", "Children's Day"], ["秋分の日", "Autumnal Equinox Day"], ["文化の日", "Culture Day"], ["勤労感謝の日", "Labor Thanksgiving Day"], ["結婚の儀", "Imperial Wedding Ceremony"], ["敬老の日", "Respect for the Aged Day"], ["体育の日", "Health and Sports Day"], ["建国記念の日", "National Foundation Day"], ["休日", "Holiday"], ["大喪の礼", "State Funeral of Emperor Showa"], ["みどりの日", "Greenery Day"], ["即位礼正殿の儀", "Enthronement Ceremony"], ["海の日", "Marine Day"], ["昭和の日", "Showa Day"], ["山の日", "Mountain Day"], ["休日（祝日扱い）", "Holiday (treated as a national holiday)"], ["体育の日（スポーツの日）", "Health and Sports Day (Sports Day)"], ["スポーツの日", "Sports Day"]];
const HOL_DATA = [
  '19550101a0115b0321c0429d0503e0505f0924g1103h1123i;19560101a0115b0321c0429d0503e0505f0923g1103h1123i',
  '19570101a0115b0321c0429d0503e0505f0923g1103h1123i;19580101a0115b0321c0429d0503e0505f0923g1103h1123i',
  '19590101a0115b0321c0410j0429d0503e0505f0924g1103h1123i;19600101a0115b0320c0429d0503e0505f0923g1103h1123i',
  '19610101a0115b0321c0429d0503e0505f0923g1103h1123i;19620101a0115b0321c0429d0503e0505f0923g1103h1123i',
  '19630101a0115b0321c0429d0503e0505f0924g1103h1123i;19640101a0115b0320c0429d0503e0505f0923g1103h1123i',
  '19650101a0115b0321c0429d0503e0505f0923g1103h1123i;19660101a0115b0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19670101a0115b0211m0321c0429d0503e0505f0915k0924g1010l1103h1123i',
  '19680101a0115b0211m0320c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19690101a0115b0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19700101a0115b0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19710101a0115b0211m0321c0429d0503e0505f0915k0924g1010l1103h1123i',
  '19720101a0115b0211m0320c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19730101a0115b0211m0321c0429d0430n0503e0505f0915k0923g0924n1010l1103h1123i',
  '19740101a0115b0211m0321c0429d0503e0505f0506n0915k0916n0923g1010l1103h1104n1123i',
  '19750101a0115b0211m0321c0429d0503e0505f0915k0924g1010l1103h1123i1124n',
  '19760101a0115b0211m0320c0429d0503e0505f0915k0923g1010l1011n1103h1123i',
  '19770101a0115b0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19780101a0102n0115b0116n0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19790101a0115b0211m0212n0321c0429d0430n0503e0505f0915k0924g1010l1103h1123i',
  '19800101a0115b0211m0320c0429d0503e0505f0915k0923g1010l1103h1123i1124n',
  '19810101a0115b0211m0321c0429d0503e0504n0505f0915k0923g1010l1103h1123i',
  '19820101a0115b0211m0321c0322n0429d0503e0505f0915k0923g1010l1011n1103h1123i',
  '19830101a0115b0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i',
  '19840101a0102n0115b0116n0211m0320c0429d0430n0503e0505f0915k0923g0924n1010l1103h1123i',
  '19850101a0115b0211m0321c0429d0503e0505f0506n0915k0916n0923g1010l1103h1104n1123i',
  '19860101a0115b0211m0321c0429d0503e0505f0915k0923g1010l1103h1123i1124n',
  '19870101a0115b0211m0321c0429d0503e0504n0505f0915k0923g1010l1103h1123i',
  '19880101a0115b0211m0320c0321n0429d0503e0504n0505f0915k0923g1010l1103h1123i',
  '19890101a0102n0115b0116n0211m0224o0321c0429p0503e0504n0505f0915k0923g1010l1103h1123i1223d',
  '19900101a0115b0211m0212n0321c0429p0430n0503e0504n0505f0915k0923g0924n1010l1103h1112q1123i1223d1224n',
  '19910101a0115b0211m0321c0429p0503e0504n0505f0506n0915k0916n0923g1010l1103h1104n1123i1223d',
  '19920101a0115b0211m0320c0429p0503e0504n0505f0915k0923g1010l1103h1123i1223d',
  '19930101a0115b0211m0320c0429p0503e0504n0505f0609j0915k0923g1010l1011n1103h1123i1223d',
  '19940101a0115b0211m0321c0429p0503e0504n0505f0915k0923g1010l1103h1123i1223d',
  '19950101a0102n0115b0116n0211m0321c0429p0503e0504n0505f0915k0923g1010l1103h1123i1223d',
  '19960101a0115b0211m0212n0320c0429p0503e0504n0505f0506n0720r0915k0916n0923g1010l1103h1104n1123i1223d',
  '19970101a0115b0211m0320c0429p0503e0505f0720r0721n0915k0923g1010l1103h1123i1124n1223d',
  '19980101a0115b0211m0321c0429p0503e0504n0505f0720r0915k0923g1010l1103h1123i1223d',
  '19990101a0115b0211m0321c0322n0429p0503e0504n0505f0720r0915k0923g1010l1011n1103h1123i1223d',
  '20000101a0110b0211m0320c0429p0503e0504n0505f0720r0915k0923g1009l1103h1123i1223d',
  '20010101a0108b0211m0212n0320c0429p0430n0503e0504n0505f0720r0915k0923g0924n1008l1103h1123i1223d1224n',
  '20020101a0114b0211m0321c0429p0503e0504n0505f0506n0720r0915k0916n0923g1014l1103h1104n1123i1223d',
  '20030101a0113b0211m0321c0429p0503e0505f0721r0915k0923g1013l1103h1123i1124n1223d',
  '20040101a0112b0211m0320c0429p0503e0504n0505f0719r0920k0923g1011l1103h1123i1223d',
  '20050101a0110b0211m0320c0321n0429p0503e0504n0505f0718r0919k0923g1010l1103h1123i1223d',
  '20060101a0102n0109b0211m0321c0429p0503e0504n0505f0717r0918k0923g1009l1103h1123i1223d',
  '20070101a0108b0211m0212n0321c0429s0430n0503e0504p0505f0716r0917k0923g0924n1008l1103h1123i1223d1224n',
  '20080101a0114b0211m0320c0429s0503e0504p0505f0506n0721r0915k0923g1013l1103h1123i1124n1223d',
  '20090101a0112b0211m0320c0429s0503e0504p0505f0506n0720r0921k0922n0923g1012l1103h1123i1223d',
  '20100101a0111b0211m0321c0322n0429s0503e0504p0505f0719r0920k0923g1011l1103h1123i1223d',
  '20110101a0110b0211m0321c0429s0503e0504p0505f0718r0919k0923g1010l1103h1123i1223d',
  '20120101a0102n0109b0211m0320c0429s0430n0503e0504p0505f0716r0917k0922g1008l1103h1123i1223d1224n',
  '20130101a0114b0211m0320c0429s0503e0504p0505f0506n0715r0916k0923g1014l1103h1104n1123i1223d',
  '20140101a0113b0211m0321c0429s0503e0504p0505f0506n0721r0915k0923g1013l1103h1123i1124n1223d',
  '20150101a0112b0211m0321c0429s0503e0504p0505f0506n0720r0921k0922n0923g1012l1103h1123i1223d',
  '20160101a0111b0211m0320c0321n0429s0503e0504p0505f0718r0811t0919k0922g1010l1103h1123i1223d',
  '20170101a0102n0109b0211m0320c0429s0503e0504p0505f0717r0811t0918k0923g1009l1103h1123i1223d',
  '20180101a0108b0211m0212n0321c0429s0430n0503e0504p0505f0716r0811t0917k0923g0924n1008l1103h1123i1223d1224n',
  '20190101a0114b0211m0321c0429s0430n0501u0502n0503e0504p0505f0506n0715r0811t0812n0916k0923g1014v1022u1103h1104n1123i',
  '20200101a0113b0211m0223d0224n0320c0429s0503e0504p0505f0506n0723r0724w0810t0921k0922g1103h1123i',
  '20210101a0111b0211m0223d0320c0429s0503e0504p0505f0722r0723w0808t0809n0920k0923g1103h1123i',
  '20220101a0110b0211m0223d0321c0429s0503e0504p0505f0718r0811t0919k0923g1010w1103h1123i',
  '20230101a0102n0109b0211m0223d0321c0429s0503e0504p0505f0717r0811t0918k0923g1009w1103h1123i',
  '20240101a0108b0211m0212n0223d0320c0429s0503e0504p0505f0506n0715r0811t0812n0916k0922g0923n1014w1103h1104n1123i',
  '20250101a0113b0211m0223d0224n0320c0429s0503e0504p0505f0506n0721r0811t0915k0923g1013w1103h1123i1124n',
  '20260101a0112b0211m0223d0320c0429s0503e0504p0505f0506n0720r0811t0921k0922n0923g1012w1103h1123i',
  '20270101a0111b0211m0223d0321c0322n0429s0503e0504p0505f0719r0811t0920k0923g1011w1103h1123i',
].join(';');

let holMap = null;
function holTable() {
  if (holMap) return holMap;
  holMap = new Map();
  for (const chunk of HOL_DATA.split(';')) {
    const y = chunk.slice(0, 4);
    for (let i = 4; i + 5 <= chunk.length; i += 5) {
      holMap.set(`${y}-${chunk.slice(i, i + 2)}-${chunk.slice(i + 2, i + 4)}`, chunk.charCodeAt(i + 4) - 97);
    }
  }
  return holMap;
}
export const holidayCount = () => holTable().size;
// その年の、同じ名前の祝日の日付（無ければ null）
function holidayDateIn(y, ja) {
  const i = HOL_NAMES.findIndex((n) => n[0] === ja);
  if (i < 0 || y < HOLIDAY_SOURCE.from || y > HOLIDAY_SOURCE.to) return null;
  for (const [k, v] of holTable()) if (v === i && k.startsWith(`${y}-`)) return { y, m: +k.slice(5, 7), d: +k.slice(8, 10) };
  return null;
}

// ---- 暦 ----
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const weekday = (y, m, d) => new Date(utc(y, m, d)).getUTCDay();
export const validDate = (y, m, d) => Number.isInteger(y) && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
function addDays(p, n) {
  const t = new Date(utc(p.y, p.m, p.d) + n * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const diffDays = (a, b) => Math.round((utc(a.y, a.m, a.d) - utc(b.y, b.m, b.d)) / 86400000);
// その月の第n のw曜日（無ければ null）
export function nthWeekday(y, m, w, n) {
  const first = (w - weekday(y, m, 1) + 7) % 7 + 1;
  const d = first + (n - 1) * 7;
  return d <= daysIn(y, m) ? d : null;
}
export function lastWeekday(y, m, w) {
  const last = daysIn(y, m);
  return last - ((weekday(y, m, last) - w + 7) % 7);
}

// 祝日の名前。範囲の外は { out: true }、祝日でなければ null。
// 表の「休日」は、直前に続く祝日の中に日曜があれば振替休日、無ければ国民の休日（祝日にはさまれた日）と読む
export function holidayOf(y, m, d) {
  if (y < HOLIDAY_SOURCE.from || y > HOLIDAY_SOURCE.to) return { out: true };
  const t = holTable();
  const i = t.get(isoOf(y, m, d));
  if (i == null) return null;
  const [ja, en] = HOL_NAMES[i];
  if (ja !== '休日') return { ja, en };
  let p = { y, m, d };
  for (let k = 0; k < 7; k++) {
    p = addDays(p, -1);
    if (t.get(isoOf(p.y, p.m, p.d)) == null) break;
    if (weekday(p.y, p.m, p.d) === 0) return { ja: '休日（振替休日）', en: 'Substitute holiday' };
  }
  return { ja: '休日（国民の休日）', en: 'Citizens’ holiday' };
}

// ---- 文の中の日付を探す ----
const D = '[0-9０-９]';
const WJ = '日月火水木金土';
const WD_EN = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
const MON_EN = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// 曜日: （土）（土曜日）（土・祝）／土曜日（括弧なしは「曜」まで要る）
const WJ_PART = `(?:\\s*(?<wp>[（(]\\s*(?<w>[${WJ}])(?:曜日?)?(?<hol>\\s*[・･,，、/]?\\s*(?:祝日?|祭日?|休日?|振休))?\\s*[）)])|\\s*(?<wb>[${WJ}])曜日?)`;
const WE_PRE = `(?:(?<we>\\b(?:${WD_EN}))\\.?,?\\s+)`;
const WE_POST = `(?:\\s*\\(\\s*(?<we2>(?:${WD_EN}))\\.?\\s*\\))`;
const RX = [
  // 2025年11月8日(土)・11月8日（土曜日）・１１月８日
  { kind: 'ja', re: new RegExp(`(?<![0-9０-９])(?:(?<y>${D}{4})\\s*年\\s*)?(?<m>${D}{1,2})\\s*月\\s*(?<d>${D}{1,2})\\s*日${WJ_PART}?`, 'dgu') },
  // 2025/11/8(土)・11/8（土）・Sat 11/8・11/8 (Sat)（年も曜日も無い 11/8 は分数などと区別できないので拾わない）
  { kind: 'num', re: new RegExp(`(?<![0-9０-９/.])${WE_PRE}?(?:(?<y>${D}{4})[/／.]\\s*)?(?<m>${D}{1,2})[/／.](?<d>${D}{1,2})(?![0-9０-９]|[/／.][0-9０-９])(?:${WJ_PART}|${WE_POST})?`, 'dgiu') },
  // 2025-11-08
  { kind: 'iso', re: new RegExp(`(?<![0-9-])(?<y>\\d{4})-(?<m>\\d{1,2})-(?<d>\\d{1,2})(?![0-9-])(?:${WJ_PART}|${WE_POST})?`, 'dgiu') },
  // Saturday, November 8, 2025・Sat Nov 8th・November 8 (Sat)
  { kind: 'en-md', re: new RegExp(`${WE_PRE}?\\b(?<mn>${MON_EN})\\.?\\s+(?<d>\\d{1,2}(?:st|nd|rd|th)?)\\b(?:,?\\s+(?<y>\\d{4})\\b)?${WE_POST}?`, 'dgiu') },
  // Saturday 8 November 2025・Sat 8th Nov
  { kind: 'en-dm', re: new RegExp(`${WE_PRE}?\\b(?<d>\\d{1,2}(?:st|nd|rd|th)?)\\s+(?<mn>${MON_EN})\\b\\.?(?:,?\\s+(?<y>\\d{4})\\b)?${WE_POST}?`, 'dgiu') },
  // 範囲の後ろの日だけの形: 11月8日（土）〜9日（日）・11/8(土)・9(日)
  { kind: 'cont', re: new RegExp(`(?<=[〜~～\\-−–—ー・、,，と]\\s{0,2})(?<d>${D}{1,2})(?:\\s*日)?${WJ_PART}`, 'dgu') },
];
const ERA_BEFORE = /(?:令和|平成|昭和|R|H)\s*(?:[0-9０-９]{1,2}|元)\s*年\s*$/;
const YEAR_MENTION = new RegExp(`(?<![0-9０-９])(?<y>${D}{4})\\s*年(?<fy>度)?|\\b(?<fy2>FY\\s?|fiscal\\s+year\\s+|school\\s+year\\s+)(?<y2>\\d{4})\\b|(?<![0-9０-９\\-/.:])(?<y3>(?:19|20)\\d{2})(?![0-9０-９\\-/.:年])`, 'dgiu');

const toInt = (s) => parseInt(String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10);
const monthOfName = (s) => { const k = s.slice(0, 3).toLowerCase(); return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(k) + 1; };
const dayOfName = (s) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3).toLowerCase());
const seg = (m, name) => (m.indices.groups && m.indices.groups[name] ? { s: m.indices.groups[name][0], e: m.indices.groups[name][1], raw: m.groups[name] } : null);

// 文 → 日付の一覧（位置・年月日・書いてある曜日・行番号）と、日付の外に書いてある年
export function findDates(text) {
  const src = String(text ?? '');
  const found = [];
  for (const { kind, re } of RX) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(src));) {
      const g = m.groups;
      const tok = { kind, start: m.index, end: m.index + m[0].length, raw: m[0] };
      tok.ys = seg(m, 'y');
      tok.ms = kind === 'en-md' || kind === 'en-dm' ? seg(m, 'mn') : seg(m, 'm');
      tok.ds = seg(m, 'd');
      tok.ws = seg(m, 'w') || seg(m, 'wb') || seg(m, 'we') || seg(m, 'we2');
      tok.hs = seg(m, 'hol');
      tok.y = g.y ? toInt(g.y) : null;
      tok.m = tok.ms ? (tok.ms.raw.match(/[0-9０-９]/) ? toInt(tok.ms.raw) : monthOfName(tok.ms.raw)) : null;
      tok.d = toInt(g.d);
      const wr = tok.ws ? tok.ws.raw : null;
      tok.w = wr == null ? null : WJ.includes(wr) ? WJ.indexOf(wr) : dayOfName(wr);
      // 年も曜日も無い 11/8・2025.11 などは日付と言い切れない
      if (kind === 'num' && tok.y == null && tok.w == null) continue;
      if (kind === 'cont' && tok.w == null) continue;
      found.push(tok);
    }
  }
  // 重なりは先に始まり長い方を残す
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const t of found) {
    const last = out[out.length - 1];
    if (last && t.start < last.end) continue;
    out.push(t);
  }
  // 行番号・続きの日（月は直前の日付から）・和暦の年
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
  const toks = [];
  for (const t of out) {
    t.line = lineOf(t.start);
    if (t.kind === 'cont') {
      const prev = toks[toks.length - 1];
      if (!prev || prev.line !== t.line) continue;
      t.m = prev.m; t.contOf = toks.length - 1;
      // 11/30(月)〜1(火) のように日が戻れば翌月
      if (t.d < prev.d) { t.m = prev.m === 12 ? 1 : prev.m + 1; t.mUp = true; }
    }
    t.era = ERA_BEFORE.test(src.slice(Math.max(0, t.start - 12), t.start));
    toks.push(t);
  }
  // 日付の外に書いてある年（2025年度・FY2025）
  const years = [];
  YEAR_MENTION.lastIndex = 0;
  for (let m; (m = YEAR_MENTION.exec(src));) {
    const s = m.index, e = m.index + m[0].length;
    if (toks.some((t) => s < t.end && e > t.start)) continue;
    years.push({ start: s, end: e, raw: m[0], y: toInt(m.groups.y || m.groups.y2 || m.groups.y3), fiscal: !!(m.groups.fy || m.groups.fy2), line: lineOf(s) });
  }
  return { tokens: toks, years, lines: src.split('\n') };
}

// ---- 時刻の逆転（同じ行の「10:00〜9:00」など） ----
const TIME = '(?:(午前|午後|am|pm)\\s*)?(\\d{1,2})(?:[:：](\\d{2})|時(?:(\\d{1,2})分|(半))?|(?=\\s*(?:am|pm)\\b))(?:\\s*(am|pm)\\b)?';
const TIME_RANGE = new RegExp(`${TIME}\\s*(?:〜|~|-|–|—|から|to)\\s*${TIME}`, 'giu');
function minutes(g, o) {
  let h = parseInt(g[o + 1], 10);
  const mi = g[o + 2] ? parseInt(g[o + 2], 10) : g[o + 3] ? parseInt(g[o + 3], 10) : g[o + 4] ? 30 : 0;
  const ap = (g[o] || g[o + 5] || '').toLowerCase();
  if ((ap === '午後' || ap === 'pm') && h < 12) h += 12;
  if ((ap === '午前' || ap === 'am') && h === 12) h = 0;
  return h * 60 + mi;
}
export function timeReversals(line) {
  const s = String(line).normalize('NFKC');
  const out = [];
  TIME_RANGE.lastIndex = 0;
  for (let m; (m = TIME_RANGE.exec(s));) {
    // 後ろの時刻に午前・午後が無ければ前の時刻のものを引き継ぐ（午後1時〜3時）
    const g = [...m];
    if (!g[7] && !g[12] && (g[1] || g[6])) g[7] = g[1] || g[6];
    const a = minutes(g, 1), b = minutes(g, 7);
    if (b <= a) out.push(m[0]);
  }
  return out;
}

// ---- 1件ずつの対応 ----
export const MODES = ['nth', 'last', 'same', 'follow'];
export const GAP_DAYS = 3;
export { diffDays };
const sameDay = (a, b) => a && b && a.y === b.y && a.m === b.m && a.d === b.d;

// 年が書かれていない日付の年: 文中の年度なら1〜3月は翌年、そうでなければ直前の日付の年（月が6以上戻れば翌年）、
// 直前が無ければ文の年。範囲の後ろの日（〜9日）は前の日の年と月（日が戻れば翌月）
function inferYears(tokens, base, fiscal) {
  const out = [];
  tokens.forEach((t, i) => {
    const prev = i > 0 ? tokens[i - 1] : null;
    const py = prev ? out[i - 1].y : null;
    if (t.y != null) { out.push({ y: t.y, src: 'text' }); return; }
    if (t.kind === 'cont' && prev) {
      out.push({ y: py + (t.mUp && prev.m === 12 ? 1 : 0), src: 'cont' });
      return;
    }
    if (fiscal) { out.push({ y: base + (t.m <= 3 ? 1 : 0), src: t.m <= 3 ? 'fiscal' : 'base' }); return; }
    if (prev) { const up = prev.m - t.m >= 6; out.push({ y: py + (up ? 1 : 0), src: up ? 'roll' : 'prev' }); return; }
    out.push({ y: base, src: 'base' });
  });
  return out;
}

// text: 前年の文 / opts.to: 今年（直す先の年） / opts.base: 文の年（省くと文から読む・無ければ to−1）
// opts.rows: { [番号]: { mode, year, anchor } } で行ごとに切り替える
export function analyze(text, opts = {}) {
  const { tokens, years, lines } = findDates(text);
  const firstYear = [...tokens.filter((t) => t.y != null).map((t) => ({ pos: t.start, y: t.y, fiscal: false })), ...years.map((y) => ({ pos: y.start, y: y.y, fiscal: y.fiscal }))]
    .sort((a, b) => a.pos - b.pos)[0];
  const thisYear = Number.isInteger(opts.now) ? opts.now : new Date().getFullYear();
  const to0 = Number.isInteger(opts.to) ? opts.to : null;
  const baseFromText = firstYear ? firstYear.y : null;
  const base = Number.isInteger(opts.base) ? opts.base : baseFromText ?? (to0 != null ? to0 - 1 : thisYear - 1);
  const to = to0 ?? base + 1;
  const k = to - base;
  const fiscal = !!(firstYear && firstYear.fiscal) || years.some((y) => y.fiscal && y.y === base);
  const rowOpt = opts.rows || {};

  // 年の読み取り
  const ys = inferYears(tokens, base, fiscal);
  const rows = tokens.map((t, i) => {
    let { y, src: ySrc } = ys[i];
    const o = rowOpt[i] || {};
    if (Number.isInteger(o.year) && t.y == null && t.kind !== 'cont') { y = o.year; ySrc = 'user'; }
    return { i, tok: t, y, ySrc };
  });
  // 行ごとに年を変えたら、続きの日（〜9日）はその前の日の年に合わせ直す
  for (const r of rows) if (r.tok.kind === 'cont' && r.i > 0) r.y = rows[r.i - 1].y + (r.tok.mUp && rows[r.i - 1].tok.m === 12 ? 1 : 0);

  // 前年の日付・曜日・第n
  for (const r of rows) {
    const t = r.tok;
    r.prior = { y: r.y, m: t.m, d: t.d };
    r.priorOk = validDate(r.y, t.m, t.d);
    r.written = t.w;
    r.warn = [];
    r.note = [];
    if (!r.priorOk) { r.warn.push({ code: 'noPrior' }); continue; }
    r.pw = weekday(r.y, t.m, t.d);
    r.n = Math.ceil(t.d / 7);
    r.isLast = t.d + 7 > daysIn(r.y, t.m);
    if (t.w != null && t.w !== r.pw) {
      const fits = [r.y - 1, r.y + 1].filter((yy) => validDate(yy, t.m, t.d) && weekday(yy, t.m, t.d) === t.w);
      r.warn.push({ code: 'wdMismatch', written: t.w, actual: r.pw, fits });
    }
    if (t.era) r.warn.push({ code: 'era' });
    r.priorHol = holidayOf(r.y, t.m, t.d);
  }

  // 間隔が変わる組（前日準備と本番のように GAP_DAYS 日以内の2件）の基準（同じ日付が多く出る方・土日の方・先に出る方）
  const weight = (r) => rows.filter((x) => x.priorOk && sameDay(x.prior, r.prior)).length * 10 + (r.pw === 0 || r.pw === 6 ? 5 : 0);
  for (const r of rows) {
    if (!r.priorOk) continue;
    if (r.tok.kind === 'cont') { r.suggestAnchor = r.i - 1; continue; }
    let best = null;
    for (const x of rows) {
      if (x === r || !x.priorOk || x.tok.kind === 'cont') continue;
      const dd = Math.abs(diffDays(r.prior, x.prior));
      if (dd === 0 || dd > GAP_DAYS) continue;
      const better = weight(x) > weight(r) || (weight(x) === weight(r) && x.i < r.i);
      if (!better) continue;
      if (!best || weight(x) > weight(best) || (weight(x) === weight(best) && dd < Math.abs(diffDays(r.prior, best.prior)))) best = x;
    }
    if (best) r.suggestAnchor = best.i;
  }

  // 移し方と候補
  const defMode = (r) => (r.tok.kind === 'cont' && r.i > 0 ? 'follow' : k === 0 ? 'same' : 'nth');
  for (const r of rows) {
    const o = rowOpt[r.i] || {};
    r.mode = MODES.includes(o.mode) ? o.mode : defMode(r);
    r.anchor = r.mode === 'follow' ? (Number.isInteger(o.anchor) && o.anchor !== r.i && rows[o.anchor] ? o.anchor : r.suggestAnchor ?? (r.i > 0 ? r.i - 1 : null)) : null;
    if (r.mode === 'follow' && r.anchor == null) r.mode = k === 0 ? 'same' : 'nth';
    r.ty = r.y + k;
  }
  const done = new Set();
  const place = (r, stack = []) => {
    if (done.has(r.i)) return r.cand;
    done.add(r.i);
    r.cand = null;
    if (!r.priorOk) return null;
    const m = r.prior.m;
    if (r.mode === 'nth') {
      const d = nthWeekday(r.ty, m, r.pw, r.n);
      if (d == null) r.warn.push({ code: 'noNth', n: r.n, w: r.pw, y: r.ty, m, last: lastWeekday(r.ty, m, r.pw) });
      else r.cand = { y: r.ty, m, d };
    } else if (r.mode === 'last') {
      r.cand = { y: r.ty, m, d: lastWeekday(r.ty, m, r.pw) };
    } else if (r.mode === 'same') {
      if (validDate(r.ty, m, r.prior.d)) r.cand = { y: r.ty, m, d: r.prior.d };
      else r.warn.push({ code: 'noSame', y: r.ty, m, d: r.prior.d });
    } else {
      const a = rows[r.anchor];
      if (stack.includes(a.i)) { r.warn.push({ code: 'loop' }); return null; }
      const ac = place(a, [...stack, r.i]);
      r.delta = diffDays(r.prior, a.prior);
      if (ac) r.cand = addDays(ac, r.delta);
      else r.warn.push({ code: 'noAnchor', anchor: a.i });
    }
    return r.cand;
  };
  for (const r of rows) place(r);

  // 候補の曜日・祝日・間隔・時刻
  const revLines = new Set();
  for (const r of rows) {
    if (r.cand) {
      r.cw = weekday(r.cand.y, r.cand.m, r.cand.d);
      r.candHol = holidayOf(r.cand.y, r.cand.m, r.cand.d);
      if (r.mode !== 'nth' && r.mode !== 'last' && r.priorOk && r.cw !== r.pw && k !== 0) r.note.push({ code: 'wdChanged', from: r.pw, to: r.cw });
    }
    if (r.priorOk && r.suggestAnchor != null && r.mode !== 'follow' && r.cand) {
      const a = rows[r.suggestAnchor];
      if (a.cand) {
        const before = diffDays(r.prior, a.prior), after = diffDays(r.cand, a.cand);
        if (before !== after) r.warn.push({ code: 'gap', anchor: a.i, before, after });
      }
    }
    if (!revLines.has(r.tok.line)) {
      revLines.add(r.tok.line);
      const rev = timeReversals(lines[r.tok.line] || '');
      if (rev.length) r.warn.push({ code: 'timeRev', times: rev });
    }
    // 前年は祝日だった行: 今年の候補が祝日でなく、同じ名前の祝日が今年にあればその日を示す（文化の日に合わせた行事など）
    if (r.cand && r.priorHol && !r.priorHol.out && !(r.candHol && !r.candHol.out) && !/^休日/.test(r.priorHol.ja)) {
      const same = holidayDateIn(r.ty, r.priorHol.ja);
      if (same) r.warn.push({ code: 'holMoved', name: r.priorHol, date: same });
    }
    r.hol = !!((r.candHol && !r.candHol.out) || (r.priorHol && !r.priorHol.out));
    r.holOut = !!(r.candHol && r.candHol.out);
  }
  // 日付の外の年（2025年度など）は k 年ずらした候補を出す（置き換えるのは確定したときだけ）
  const yearRows = k === 0 ? [] : years.map((y, i) => ({ i, tok: y, from: y.y, to: y.y + k, line: y.line, replacement: y.raw.replace(/[0-9０-９]{4}/, (x) => fmtNum(y.y + k, x)) }));
  return {
    base, to, k, fiscal, baseFromText, rows, yearRows,
    warnings: rows.reduce((n, r) => n + r.warn.length, 0),
    holidays: rows.filter((r) => r.hol).length,
    outOfRange: to > HOLIDAY_SOURCE.to || base < HOLIDAY_SOURCE.from,
    hint: suggestBase(tokens, base, baseFromText, thisYear, fiscal),
  };
}

// 年がどこにも書いていない文で、仮定した年では曜日の合わない日付があり、別の年として読むとすべて合うとき、その年を返す
function suggestBase(tokens, base, baseFromText, thisYear, fiscal) {
  if (baseFromText != null) return null;
  if (!tokens.some((t) => t.w != null)) return null;
  const misses = (b) => {
    const ys = inferYears(tokens, b, fiscal);
    return tokens.filter((t, i) => t.w != null && !(validDate(ys[i].y, t.m, t.d) && weekday(ys[i].y, t.m, t.d) === t.w)).length;
  };
  if (misses(base) === 0) return null;
  const ok = [];
  for (let y = thisYear - 8; y <= thisYear + 2; y++) if (y !== base && misses(y) === 0) ok.push(y);
  return ok.length ? ok.sort((a, b) => Math.abs(a - base) - Math.abs(b - base))[0] : null;
}

// ---- 書き換え ----
const FW = (s) => s.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
function fmtNum(v, raw) {
  const isFw = /[０-９]/.test(raw);
  const digits = raw.replace(/[^0-9０-９]/g, '');
  let s = String(v);
  // 08 のように0を前に付けて書いていたときだけ桁をそろえる（10日→9日は「09日」にしない）
  if (/^[0０]/.test(digits) && digits.length >= 2 && s.length < digits.length) s = s.padStart(digits.length, '0');
  return isFw ? FW(s) : s;
}
const ordinal = (n) => { const t = n % 100; if (t >= 11 && t <= 13) return 'th'; return ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; };
function caseLike(word, raw) {
  if (raw === raw.toUpperCase()) return word.toUpperCase();
  if (raw === raw.toLowerCase()) return word.toLowerCase();
  return word;
}
function fmtName(full, raw) {
  const r = raw.replace(/\.$/, '');
  if (r.length >= full.length || r.toLowerCase() === full.toLowerCase()) return caseLike(full, r);
  if (r.length === 4 && /^sept$/i.test(r) && full === 'September') return caseLike('Sept', r);
  if (r.length === 4 && full.length > 4 && /^(tues|thur)$/i.test(r)) return caseLike(full.slice(0, 4), r);
  if (r.length === 5 && /^thurs$/i.test(r) && full === 'Thursday') return caseLike('Thurs', r);
  return caseLike(full.slice(0, 3), r);
}
// 1件の書き換え後の文字列（その日付の部分だけ）
export function formatToken(tok, c) {
  const parts = [];
  if (tok.ys) parts.push([tok.ys, fmtNum(c.y, tok.ys.raw)]);
  if (tok.ms && tok.kind !== 'cont') parts.push([tok.ms, /[0-9０-９]/.test(tok.ms.raw) ? fmtNum(c.m, tok.ms.raw) : fmtName(EN_MONTHS[c.m - 1], tok.ms.raw)]);
  if (tok.ds) {
    const suf = tok.ds.raw.match(/(st|nd|rd|th)$/i);
    const num = fmtNum(c.d, tok.ds.raw.replace(/(st|nd|rd|th)$/i, ''));
    parts.push([tok.ds, suf ? num + caseLike(ordinal(c.d), suf[1]) : num]);
  }
  const w = weekday(c.y, c.m, c.d);
  if (tok.ws) parts.push([tok.ws, WJ.includes(tok.ws.raw) ? WJ[w] : fmtName(EN_DAYS[w], tok.ws.raw)]);
  // （土・祝）の「祝」は、今年の候補が祝日でなければ外す
  if (tok.hs) {
    const h = holidayOf(c.y, c.m, c.d);
    if (!h || h.out) parts.push([tok.hs, '']);
  }
  parts.sort((a, b) => b[0].s - a[0].s);
  let s = tok.raw;
  for (const [p, v] of parts) s = s.slice(0, p.s - tok.start) + v + s.slice(p.e - tok.start);
  return s;
}
// 確定した行（confirm: 番号の配列か 'all'）だけを置き換えた文
// 日付の外の年（2025年度）は confirmYears（番号の配列か 'all'）で同じように選ぶ
export function applyRows(text, result, confirm = 'all', confirmYears = confirm === 'all' ? 'all' : []) {
  const src = String(text ?? '');
  const on = confirm === 'all' ? null : new Set(confirm);
  const onY = confirmYears === 'all' ? null : new Set(confirmYears);
  const edits = [];
  for (const r of result.rows) if (r.cand && (!on || on.has(r.i))) edits.push([r.tok.start, r.tok.end, formatToken(r.tok, r.cand)]);
  for (const y of result.yearRows || []) if (!onY || onY.has(y.i)) edits.push([y.tok.start, y.tok.end, y.replacement]);
  edits.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [s, e, v] of edits) { out += src.slice(pos, s) + v; pos = e; }
  return out + src.slice(pos);
}

// ---- 表示の言葉 ----
const WD = { ja: [...WJ], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
export function shortDate(p, lang = 'ja') {
  if (!p) return '—';
  const w = weekday(p.y, p.m, p.d);
  return lang === 'en' ? `${WD.en[w]} ${EN_MONTHS[p.m - 1].slice(0, 3)} ${p.d}` : `${p.m}/${p.d}(${WD.ja[w]})`;
}
export function ruleLabel(r, lang = 'ja', rows = []) {
  const en = lang === 'en';
  const w = r.pw;
  if (r.pw == null) return '';
  if (r.mode === 'nth') return en ? `${['1st', '2nd', '3rd', '4th', '5th'][r.n - 1]} ${EN_DAYS[w]}` : `第${r.n}${WD.ja[w]}曜`;
  if (r.mode === 'last') return en ? `last ${EN_DAYS[w]}` : `最終${WD.ja[w]}曜`;
  if (r.mode === 'same') return en ? 'same date' : '同じ日付';
  const a = rows[r.anchor];
  const dd = r.delta ?? 0;
  const ref = a ? shortDate(a.prior, lang) : '';
  if (en) return dd === 0 ? `same day as ${ref}` : `${Math.abs(dd)} day${Math.abs(dd) === 1 ? '' : 's'} ${dd > 0 ? 'after' : 'before'} ${ref}`;
  return dd === 0 ? `${ref}と同じ日` : `${ref}の${Math.abs(dd)}日${dd > 0 ? '後' : '前'}`;
}
const holName = (h, lang) => (h && !h.out ? (lang === 'en' ? h.en : h.ja) : '');
export function warnText(w, lang = 'ja', rows = []) {
  const en = lang === 'en';
  const W = (i) => (en ? EN_DAYS[i] : WD.ja[i] + '曜');
  switch (w.code) {
    case 'noPrior': return en ? 'This date does not exist in that year' : 'この年の暦に無い日付';
    case 'wdMismatch': return (en ? `Written as ${W(w.written)}, but the calendar says ${W(w.actual)}` : `文では${W(w.written)}、暦では${W(w.actual)}`) + (w.fits.length ? (en ? ` (matches ${w.fits.join(', ')})` : `（${w.fits.join('・')}年なら合う）`) : '');
    case 'era': return en ? 'The Japanese era year before this date is not changed' : '前に書いてある和暦の年は書き換えない';
    case 'noNth': return en ? `${['', '1st', '2nd', '3rd', '4th', '5th'][w.n]} ${W(w.w)} does not exist in ${EN_MONTHS[w.m - 1]} ${w.y} (the last one is ${EN_MONTHS[w.m - 1].slice(0, 3)} ${w.last})` : `${w.y}年${w.m}月に第${w.n}${W(w.w)}は無い（最終${W(w.w)}は${w.m}/${w.last}）`;
    case 'noSame': return en ? `${EN_MONTHS[w.m - 1]} ${w.d} does not exist in ${w.y}` : `${w.y}年に${w.m}月${w.d}日は無い`;
    case 'noAnchor': return en ? 'The date it follows has no candidate' : '基準の日付に候補が無い';
    case 'loop': return en ? 'The dates follow each other in a loop' : '基準の日付がお互いを指している';
    case 'gap': {
      const a = rows[w.anchor];
      const s = (n) => (en ? (n === 0 ? 'same day' : `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n > 0 ? 'after' : 'before'}`) : n === 0 ? '同じ日' : `${Math.abs(n)}日${n > 0 ? '後' : '前'}`);
      const ref = a ? shortDate(a.prior, lang) : '';
      return en ? `Was ${s(w.before)} ${ref}; becomes ${s(w.after)}` : `${ref}の${s(w.before)}だったのが、${s(w.after)}になる`;
    }
    case 'holMoved': return en ? `Was ${w.name.en}; in ${w.date.y} it falls on ${shortDate(w.date, lang)}` : `前年は${w.name.ja}。${w.date.y}年の${w.name.ja}は${shortDate(w.date, lang)}`;
    case 'timeRev': return (en ? 'End time is not after the start: ' : '時刻の終わりが始まりより前: ') + w.times.join(', ');
    default: return '';
  }
}
export function rowView(res, r, lang = 'ja') {
  return {
    n: r.i + 1,
    text: r.tok.raw,
    line: r.tok.line + 1,
    prior: r.priorOk ? shortDate(r.prior, lang) : r.tok.raw,
    priorIso: r.priorOk ? isoOf(r.prior.y, r.prior.m, r.prior.d) : null,
    year: r.y,
    yearAssumed: r.ySrc !== 'text',
    yearFrom: r.ySrc,
    mode: r.mode,
    rule: ruleLabel(r, lang, res.rows),
    candidate: r.cand ? shortDate(r.cand, lang) : null,
    candidateIso: r.cand ? isoOf(r.cand.y, r.cand.m, r.cand.d) : null,
    replacement: r.cand ? formatToken(r.tok, r.cand) : null,
    holidayNow: r.candHol ? (r.candHol.out ? (lang === 'en' ? 'outside holiday data' : '祝日データ対象外') : holName(r.candHol, lang)) : '',
    holidayBefore: holName(r.priorHol, lang),
    warnings: r.warn.map((w) => warnText(w, lang, res.rows)),
  };
}
// 共有カードの1行（本文を含まない）: 11/8(土)→11/14(土) 第2土曜
export function cardLines(res, lang = 'ja', max = 6) {
  const seen = new Set(), out = [];
  for (const r of res.rows) {
    if (!r.priorOk) continue;
    const key = `${isoOf(r.prior.y, r.prior.m, r.prior.d)}>${r.cand ? isoOf(r.cand.y, r.cand.m, r.cand.d) : '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: shortDate(r.prior, lang), to: r.cand ? shortDate(r.cand, lang) : (lang === 'en' ? 'no date' : '候補なし'), rule: ruleLabel(r, lang, res.rows), hol: !!(r.candHol && !r.candHol.out), holBefore: !!(r.priorHol && !r.priorHol.out), warn: r.warn.length > 0 });
  }
  return { lines: out.slice(0, max), more: Math.max(0, out.length - max) };
}
// ==================== ここまでコア ====================

// ---- MCP の入口 ----
export class ShiftNoticeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const MAX_TEXT = 200000;

// rows: [{ n, mode, year, anchor }]（n・anchor は1から数える行の番号）
// apply: 'all'（既定）| 'none' | 置き換える行の番号の配列。applyYears: 日付の外の年（2025年度）の番号の配列（apply が 'all' なら全部）
export function shiftNoticeTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const text = opts.text;
  if (typeof text !== 'string' || text.trim() === '') throw new ShiftNoticeError('NO_TEXT', 'text is required');
  if (text.length > MAX_TEXT) throw new ShiftNoticeError('TOO_LONG', `text must be ${MAX_TEXT} characters or fewer`);
  const yearOk = (y) => Number.isInteger(y) && y >= 1900 && y <= 2200;
  if (opts.to != null && !yearOk(opts.to)) throw new ShiftNoticeError('BAD_YEAR', 'to must be a year from 1900 to 2200');
  if (opts.base != null && !yearOk(opts.base)) throw new ShiftNoticeError('BAD_YEAR', 'base must be a year from 1900 to 2200');
  const rowsOpt = {};
  for (const r of opts.rows || []) {
    if (!r || !Number.isInteger(r.n) || r.n < 1) throw new ShiftNoticeError('BAD_ROW', 'rows[].n must be a row number starting at 1');
    if (r.mode != null && !MODES.includes(r.mode)) throw new ShiftNoticeError('BAD_MODE', `rows[].mode must be one of ${MODES.join(', ')}`);
    if (r.year != null && !yearOk(r.year)) throw new ShiftNoticeError('BAD_YEAR', 'rows[].year must be a year from 1900 to 2200');
    rowsOpt[r.n - 1] = { mode: r.mode, year: r.year, anchor: Number.isInteger(r.anchor) ? r.anchor - 1 : undefined };
  }
  const res = analyze(text, { to: opts.to, base: opts.base, rows: rowsOpt, now: Number.isInteger(opts.now) ? opts.now : undefined });
  const apply = opts.apply ?? 'all';
  let confirm, confirmYears;
  if (apply === 'all') { confirm = 'all'; confirmYears = 'all'; }
  else if (apply === 'none') { confirm = []; confirmYears = []; }
  else if (Array.isArray(apply)) { confirm = apply.map((n) => n - 1); confirmYears = (opts.applyYears || []).map((n) => n - 1); }
  else throw new ShiftNoticeError('BAD_APPLY', "apply must be 'all', 'none' or an array of row numbers");
  const rows = res.rows.map((r) => {
    const v = rowView(res, r, lang);
    if (r.suggestAnchor != null) v.suggestedAnchor = r.suggestAnchor + 1;
    if (r.mode === 'follow' && r.anchor != null) v.anchor = r.anchor + 1;
    v.applied = !!r.cand && (confirm === 'all' || confirm.includes(r.i));
    return v;
  });
  const yearRows = res.yearRows.map((y) => ({ n: y.i + 1, text: y.tok.raw, replacement: y.replacement, line: y.line + 1, applied: confirmYears === 'all' || confirmYears.includes(y.i) }));
  return {
    base: res.base,
    to: res.to,
    shiftYears: res.k,
    fiscalYear: res.fiscal,
    baseFromText: res.baseFromText,
    suggestedBase: res.hint,
    counts: { dates: res.rows.length, warnings: res.warnings, holidays: res.holidays, applied: rows.filter((r) => r.applied).length },
    rows,
    yearRows,
    text: applyRows(text, res, confirm, confirmYears),
    holidayData: { source: HOLIDAY_SOURCE.name[lang], url: HOLIDAY_SOURCE.url, csv: HOLIDAY_SOURCE.csv, from: HOLIDAY_SOURCE.from, to: HOLIDAY_SOURCE.to, checked: HOLIDAY_SOURCE.checked, outOfRange: res.outOfRange },
    note: lang === 'en'
      ? 'Every row is a candidate to check by a person; nothing is confirmed automatically. Only dates are changed (no era names, rokuyō, business days, fees, names or venues).'
      : 'すべて要確認の候補で、自動では確定しない。書き換えるのは日付だけ（和暦・六曜・営業日・会費・担当者名・会場は扱わない）。',
    url: lang === 'en' ? 'https://tools.first-ch.com/en/hizuke/' : 'https://tools.first-ch.com/hizuke/',
  };
}
