/* 休みの曜日が違う2人の2027年（renkyu_pair_plan）
 * 計算のコアは FirstCHTools の site/renkyu-2027/plan.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' site/renkyu-2027/plan.js) <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' renkyu-pair.mjs)
 *
 * 2人それぞれの休みの曜日・祝日と年末年始に休むか・使える有給と、2人の有給の合計の上限から、
 * 2027年に2人そろって休める日数（月ごと）と、有給を足して作れる連休の候補（最大3件）を返す。
 * 祝日は内閣府「国民の祝日について」の令和9年の表（17日）。完全ローカル処理・ネットワーク送信なし。 */

// ==================== ここからコア ====================
export const YEAR = 2027;

// 内閣府「国民の祝日について」の令和9年（2027年）の表どおり。祝日16日と、祝日法第3条第2項による休日（3/22）1日の計17日。
// 2028年以降は内閣府が翌年分を公表してから差し替える。
export const HOLIDAYS = [
  ['2027-01-01', '元日', 'New Year’s Day'],
  ['2027-01-11', '成人の日', 'Coming of Age Day'],
  ['2027-02-11', '建国記念の日', 'National Foundation Day'],
  ['2027-02-23', '天皇誕生日', 'Emperor’s Birthday'],
  ['2027-03-21', '春分の日', 'Vernal Equinox Day'],
  ['2027-03-22', '休日（振替休日）', 'Substitute holiday'],
  ['2027-04-29', '昭和の日', 'Showa Day'],
  ['2027-05-03', '憲法記念日', 'Constitution Memorial Day'],
  ['2027-05-04', 'みどりの日', 'Greenery Day'],
  ['2027-05-05', 'こどもの日', 'Children’s Day'],
  ['2027-07-19', '海の日', 'Marine Day'],
  ['2027-08-11', '山の日', 'Mountain Day'],
  ['2027-09-20', '敬老の日', 'Respect for the Aged Day'],
  ['2027-09-23', '秋分の日', 'Autumnal Equinox Day'],
  ['2027-10-11', 'スポーツの日', 'Sports Day'],
  ['2027-11-03', '文化の日', 'Culture Day'],
  ['2027-11-23', '勤労感謝の日', 'Labour Thanksgiving Day'],
];
export const SOURCE = { url: 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html', checked: '2026-11-17' };

export const LEAVE_MAX = 10;    // 1人が使える有給の上限
export const TOTAL_MAX = 20;    // 2人の合計の上限 N
export const SHARE_BASE = 'https://tools.first-ch.com/renkyu-2027/';
export const DEFAULTS = Object.freeze({
  me: Object.freeze({ days: Object.freeze([0, 6]), holidays: true, yearEnd: true, leave: 3 }),
  partner: Object.freeze({ days: Object.freeze([0, 6]), holidays: true, yearEnd: true, leave: 3 }),
  maxTotal: 6,
});

const DAY_MS = 86400000;
const START = Date.UTC(YEAR, 0, 1);
export const DAYS_IN_YEAR = Math.round((Date.UTC(YEAR + 1, 0, 1) - START) / DAY_MS);
const HOLIDAY_SET = new Set(HOLIDAYS.map((h) => h[0]));

export class RenkyuError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const pad = (n) => String(n).padStart(2, '0');
export function isoOf(i) {
  const d = new Date(START + i * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function indexOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return -1;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const i = Math.round((t - START) / DAY_MS);
  return i >= 0 && i < DAYS_IN_YEAR && isoOf(i) === iso ? i : -1;
}
export const weekdayOf = (i) => new Date(START + i * DAY_MS).getUTCDay();   // 0=日〜6=土
export const monthOf = (i) => new Date(START + i * DAY_MS).getUTCMonth();   // 0=1月
export const isHoliday = (i) => HOLIDAY_SET.has(isoOf(i));
// 年末年始（12/29〜1/3）のうち、この年に入る日（1/1〜1/3 と 12/29〜12/31）
export function isYearEnd(i) {
  const d = new Date(START + i * DAY_MS);
  const m = d.getUTCMonth(); const day = d.getUTCDate();
  return (m === 0 && day <= 3) || (m === 11 && day >= 29);
}

function intIn(v, lo, hi, def) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function normDays(v, def) {
  if (v == null) return def.slice();
  const list = Array.isArray(v) ? v : String(v).split('').filter((c) => /\d/.test(c));
  const out = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  return out.sort((a, b) => a - b);
}
function normPerson(p, def) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    days: normDays(o.days, def.days),
    holidays: o.holidays == null ? def.holidays : !!o.holidays,
    yearEnd: o.yearEnd == null ? def.yearEnd : !!o.yearEnd,
    leave: intIn(o.leave, 0, LEAVE_MAX, def.leave),
  };
}
// 範囲の外・形の違う値は既定値か端の値に寄せる（画面とURLの復元用）
export function normalize(input) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    me: normPerson(o.me, DEFAULTS.me),
    partner: normPerson(o.partner, DEFAULTS.partner),
    maxTotal: intIn(o.maxTotal, 0, TOTAL_MAX, DEFAULTS.maxTotal),
  };
}

// 1人の休み（曜日・祝日・年末年始）を日ごとの真偽で返す
export function offDays(p) {
  const wd = new Set(p.days);
  const out = new Array(DAYS_IN_YEAR);
  for (let i = 0; i < DAYS_IN_YEAR; i++) {
    out[i] = wd.has(weekdayOf(i)) || (p.holidays && isHoliday(i)) || (p.yearEnd && isYearEnd(i));
  }
  return out;
}

// 2人の休み・そろって休める日数（月ごと）・有給を足した連休の候補（最大 limit 件）。
// 候補は「その期間の毎日、2人とも休みか有給」で、各自の有給の上限と合計の上限 N の両方を守る。
// 前後の日も2人そろって休みなら必ず延ばせるので、期間の外側の隣は「どちらかが休みでない日」か年の端に限る。
// 並べ方: 連続日数の長い順 → 有給の合計の少ない順 → 2人の有給の差の小さい順 → 始まりの早い順。期間が重なる候補は上位の1件だけ残す。
export function planPair(input, limit = 3) {
  const c = normalize(input);
  const A = offDays(c.me); const B = offDays(c.partner);
  const both = A.map((a, i) => a && B[i]);
  const perMonth = new Array(12).fill(0);
  let together = 0; let meOff = 0; let partnerOff = 0;
  const pa = [0]; const pb = [0];
  for (let i = 0; i < DAYS_IN_YEAR; i++) {
    if (both[i]) { together++; perMonth[monthOf(i)]++; }
    if (A[i]) meOff++;
    if (B[i]) partnerOff++;
    pa.push(pa[i] + (A[i] ? 0 : 1));
    pb.push(pb[i] + (B[i] ? 0 : 1));
  }
  const la = c.me.leave; const lb = c.partner.leave; const n = c.maxTotal;
  const wins = [];
  for (let s = 0; s < DAYS_IN_YEAR; s++) {
    if (s > 0 && both[s - 1]) continue;
    for (let e = s; e < DAYS_IN_YEAR; e++) {
      const ua = pa[e + 1] - pa[s]; const ub = pb[e + 1] - pb[s];
      if (ua > la || ub > lb || ua + ub > n) break;
      if (e === DAYS_IN_YEAR - 1 || !both[e + 1]) wins.push({ s, e, ua, ub });
    }
  }
  wins.sort((x, y) => (y.e - y.s) - (x.e - x.s) || (x.ua + x.ub) - (y.ua + y.ub)
    || Math.abs(x.ua - x.ub) - Math.abs(y.ua - y.ub) || x.s - y.s);
  const picked = [];
  for (const w of wins) {
    if (picked.length >= limit) break;
    if (picked.some((p) => w.s <= p.e && p.s <= w.e)) continue;
    picked.push(w);
  }
  const leaveOf = (arr, w) => { const r = []; for (let i = w.s; i <= w.e; i++) if (!arr[i]) r.push(isoOf(i)); return r; };
  const candidates = picked.map((w) => ({
    start: isoOf(w.s), end: isoOf(w.e), days: w.e - w.s + 1,
    meLeave: leaveOf(A, w), partnerLeave: leaveOf(B, w), totalLeave: w.ua + w.ub,
  }));
  return { year: YEAR, conditions: c, together, perMonth, meOff, partnerOff, candidates };
}

// 2人分の条件を URL の # 以降の文字列にする（例 a=06&ah=1&ay=1&al=3&b=3&bh=0&by=1&bl=3&n=6）
export function toHash(input) {
  const c = normalize(input);
  const q = [];
  for (const [k, p] of [['a', c.me], ['b', c.partner]]) {
    q.push(`${k}=${p.days.join('')}`, `${k}h=${p.holidays ? 1 : 0}`, `${k}y=${p.yearEnd ? 1 : 0}`, `${k}l=${p.leave}`);
  }
  q.push(`n=${c.maxTotal}`);
  return q.join('&');
}
export function fromHash(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (![...q.keys()].some((k) => /^(a|b)[hyl]?$|^n$/.test(k))) return null;
  const flag = (k) => (q.has(k) ? q.get(k) === '1' : undefined);
  const num = (k) => (q.has(k) ? q.get(k) : undefined);
  const person = (k) => ({ days: q.has(k) ? q.get(k) : undefined, holidays: flag(k + 'h'), yearEnd: flag(k + 'y'), leave: num(k + 'l') });
  return normalize({ me: person('a'), partner: person('b'), maxTotal: num('n') });
}
export const swap = (input) => { const c = normalize(input); return { me: c.partner, partner: c.me, maxTotal: c.maxTotal }; };

const WD = { ja: ['日', '月', '火', '水', '木', '金', '土'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 5/1(土) ／ Sat 1 May
export function fmtDay(iso, lang = 'ja', withWeekday = true) {
  const i = indexOf(iso); if (i < 0) return '';
  const d = new Date(START + i * DAY_MS); const w = WD[lang === 'en' ? 'en' : 'ja'][d.getUTCDay()];
  if (lang === 'en') return `${withWeekday ? w + ' ' : ''}${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}${withWeekday ? `(${w})` : ''}`;
}
export function fmtRange(c, lang = 'ja', withWeekday = false) {
  const a = fmtDay(c.start, lang, withWeekday);
  if (c.start === c.end) return a;
  return lang === 'en' ? `${a}–${fmtDay(c.end, lang, withWeekday)}` : `${a}〜${fmtDay(c.end, lang, withWeekday)}`;
}

// 「コピー」で写す文（URL は別に足す）
export function shareText(result, lang = 'ja') {
  const r = result; const top = r.candidates[0];
  if (lang === 'en') {
    const head = `In ${r.year}, we can both be off on ${r.together} day${r.together === 1 ? '' : 's'}.`;
    if (!top) return head;
    const a = top.meLeave.length; const b = top.partnerLeave.length;
    const use = a + b === 0 ? 'Without any paid leave' : `With ${a} day${a === 1 ? '' : 's'} of leave for me and ${b} for you`;
    return `${head} ${use}, we get ${fmtRange(top, 'en')} off${top.days >= 2 ? `: ${top.days} days in a row` : ''}.`;
  }
  const head = `${r.year}年、2人そろって休めるのは${r.together}日。`;
  if (!top) return head;
  const a = top.meLeave.length; const b = top.partnerLeave.length;
  const use = a + b === 0 ? '有給なしで' : `有給をわたし${a}日・相手${b}日使うと`;
  return `${head}${use}${fmtRange(top, 'ja')}の${top.days >= 2 ? `${top.days}連休` : '1日'}`;
}
export const shareUrl = (input) => `${SHARE_BASE}#${toHash(input)}`;
// ==================== ここまでコア ====================

// ---- MCP の入口 ----
function checkPerson(p, name) {
  if (p == null) return;
  if (typeof p !== 'object' || Array.isArray(p)) throw new RenkyuError('BAD_INPUT', `${name} must be an object`);
  if (p.days != null) {
    if (!Array.isArray(p.days) || p.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new RenkyuError('BAD_DAYS', `${name}.days must be an array of integers 0 (Sunday) to 6 (Saturday)`);
    }
  }
  if (p.leave != null && (!Number.isInteger(p.leave) || p.leave < 0 || p.leave > LEAVE_MAX)) {
    throw new RenkyuError('BAD_LEAVE', `${name}.leave must be an integer from 0 to ${LEAVE_MAX}`);
  }
}

export function renkyuPairTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  checkPerson(opts.me, 'me');
  checkPerson(opts.partner, 'partner');
  if (opts.maxTotal != null && (!Number.isInteger(opts.maxTotal) || opts.maxTotal < 0 || opts.maxTotal > TOTAL_MAX)) {
    throw new RenkyuError('BAD_TOTAL', `maxTotal must be an integer from 0 to ${TOTAL_MAX}`);
  }
  const base = normalize({ me: opts.me, partner: opts.partner });
  // maxTotal を省いたら2人の有給の和（＝合計では縛らない）
  const input = { ...base, maxTotal: opts.maxTotal ?? base.me.leave + base.partner.leave };
  const r = planPair(input);
  const url = shareUrl(input).replace('/renkyu-2027/', lang === 'en' ? '/en/renkyu-2027/' : '/renkyu-2027/');
  return {
    year: r.year,
    conditions: r.conditions,
    together: r.together,
    perMonth: r.perMonth,
    meOff: r.meOff,
    partnerOff: r.partnerOff,
    candidates: r.candidates.map((c) => ({ ...c, label: fmtRange(c, lang, true) })),
    text: shareText(r, lang),
    url,
    holidays: { count: HOLIDAYS.length, source: SOURCE.url, checked: SOURCE.checked },
  };
}
