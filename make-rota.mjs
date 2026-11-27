/* 交代が出ても、変わった人に変わった日だけ届く当番表（make_rota）
 * 計算のコアは FirstCHTools の site/toban/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' site/toban/lib.mjs) <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' make-rota.mjs)
 *
 * 番号で回す当番（PTA の旗振り・町内会のごみ当番など）の表を、行けない曜日を破らず回数差が最小（1以内にできれば必ず1以内）
 * になるように作る。前に配ったリンクと交代を渡すと版を上げ、前の版から変わった枠・番号ごとの追加と削除の日・新しいリンクを返す。
 * 祝日は shift-notice.mjs と同じ内閣府の祝日CSV（1955〜2027年）。完全ローカル処理・ネットワーク送信なし。氏名は扱わない。 */
import { holidayOf, HOLIDAY_SOURCE, weekday, daysIn } from './shift-notice.mjs';
import { randomBytes } from 'node:crypto';

// ==================== ここからコア ====================
// 番号で回す当番（PTA の旗振り・町内会のごみ当番など）の表を作り、交代で直した版と前の版の差分を出す。
// 割り振りは「行けない曜日を破らない」を絶対条件にし、全員の回数差を1以内にできる表があれば必ずそれを出す
// （番号と曜日の枠を流量の問題として解き、日付順の決め打ちはしない）。共有のリンクには番号と日付だけを入れる。

export const LIMITS = Object.freeze({ members: 99, perDay: 5, spanDays: 366, title: 30 });
// 祝日の表がある最後の年（これより後の日は「祝日は未確認」）
export const HOLIDAY_TO = HOLIDAY_SOURCE.to;
export const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];
export const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- 暦 ----
const pad2 = (n) => String(n).padStart(2, '0');
export const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const DAY = 86400000;
const toT = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromT = (t) => { const x = new Date(t); return isoOf(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
export const addDaysIso = (iso, n) => fromT(toT(iso) + n * DAY);
export const daysBetween = (a, b) => Math.round((toT(b) - toT(a)) / DAY);
export function parseIso(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  return isoOf(y, mo, d);
}
export const wdOf = (iso) => weekday(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10));
export function holidayName(iso, lang = 'ja') {
  const h = holidayOf(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10));
  if (!h) return null;
  if (h.out) return { unknown: true };
  return { name: lang === 'en' ? h.en : h.ja };
}
// 「12/1(火)」「Tue 1 Dec」
export function dateLabel(iso, lang = 'ja', withYear = false) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10), w = wdOf(iso);
  if (lang === 'en') return `${WD_EN[w]} ${d} ${MON_EN[m - 1]}${withYear ? ` ${y}` : ''}`;
  return `${withYear ? `${y}/` : ''}${m}/${d}(${WD_JA[w]})`;
}

// 除外日の文（「12/24, 12/28-1/7, 2027-02-10」）を日付の集合へ。年の無い日付は期間の中に入る年で読む
export function parseExcludes(text, start, end) {
  const dates = new Set();
  const bad = [];
  const src = String(text ?? '').normalize('NFKC').replace(/[〜~～]/g, '-').replace(/\s*-\s*/g, '-');
  const toks = src.split(/[\s,、;；]+/).filter(Boolean);
  const y0 = +start.slice(0, 4);
  const one = (s) => {
    let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
    if (m) return parseIso(`${m[1]}-${m[2]}-${m[3]}`);
    m = /^(\d{1,2})[/.月](\d{1,2})日?$/.exec(s);
    if (!m) return null;
    for (const y of [y0, y0 + 1, y0 - 1]) {
      const iso = parseIso(`${y}-${m[1]}-${m[2]}`);
      if (iso && iso >= start && iso <= end) return iso;
    }
    return parseIso(`${y0}-${m[1]}-${m[2]}`);
  };
  for (const tok of toks) {
    const a = one(tok);
    if (a) { dates.add(a); continue; }
    // 範囲「12/28-1/7」「2026-12-28-2027-01-07」: どこで2つに分けると両方が日付になるかを探す
    let range = null;
    for (let i = tok.indexOf('-'); i > 0 && !range; i = tok.indexOf('-', i + 1)) {
      const x = one(tok.slice(0, i));
      let y = one(tok.slice(i + 1));
      if (!x || !y) continue;
      if (y < x && !/^\d{4}/.test(tok.slice(i + 1))) y = parseIso(`${+y.slice(0, 4) + 1}${y.slice(4)}`);
      if (y && y >= x) range = [x, y];
    }
    if (!range || daysBetween(range[0], range[1]) > LIMITS.spanDays) { bad.push(tok); continue; }
    for (let d = range[0]; d <= range[1]; d = addDaysIso(d, 1)) dates.add(d);
  }
  return { dates, bad };
}

// 期間・曜日・除外日・祝日から当番の日を並べる
export function buildDates({ start, end, weekdays, exclude = new Set(), skipHolidays = true, lang = 'ja' }) {
  const s = parseIso(start), e = parseIso(end);
  if (!s || !e) return { error: 'BAD_DATE' };
  if (e < s) return { error: 'END_BEFORE_START' };
  if (daysBetween(s, e) >= LIMITS.spanDays) return { error: 'TOO_LONG' };
  const wds = new Set((weekdays || []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6));
  if (!wds.size) return { error: 'NO_WEEKDAY' };
  const dates = [], holidays = [], excluded = [], unknown = [];
  for (let d = s; d <= e; d = addDaysIso(d, 1)) {
    if (!wds.has(wdOf(d))) continue;
    if (exclude.has(d)) { excluded.push(d); continue; }
    const h = holidayName(d, lang);
    if (h && h.unknown) unknown.push(d);
    else if (h && skipHolidays) { holidays.push({ iso: d, name: h.name }); continue; }
    dates.push(d);
  }
  return { dates, holidays, excluded, unknown, holidayDataTo: HOLIDAY_SOURCE.to };
}

// ---- 流量（Dinic）----
class Flow {
  constructor(n) { this.n = n; this.g = Array.from({ length: n }, () => []); }
  add(u, v, c) {
    const a = { to: v, cap: c, rev: null }, b = { to: u, cap: 0, rev: a };
    a.rev = b; this.g[u].push(a); this.g[v].push(b);
    return a;
  }
  max(s, t) {
    let total = 0;
    for (;;) {
      const lv = new Array(this.n).fill(-1); lv[s] = 0;
      const q = [s];
      for (let i = 0; i < q.length; i++) for (const e of this.g[q[i]]) if (e.cap > 0 && lv[e.to] < 0) { lv[e.to] = lv[q[i]] + 1; q.push(e.to); }
      if (lv[t] < 0) return total;
      const it = new Array(this.n).fill(0);
      const dfs = (u, f) => {
        if (u === t) return f;
        for (; it[u] < this.g[u].length; it[u]++) {
          const e = this.g[u][it[u]];
          if (e.cap > 0 && lv[e.to] === lv[u] + 1) {
            const got = dfs(e.to, Math.min(f, e.cap));
            if (got > 0) { e.cap -= got; e.rev.cap += got; return got; }
          }
        }
        return 0;
      };
      for (let f; (f = dfs(s, Infinity)) > 0;) total += f;
    }
  }
}

// mask[n]: 番号 n（1から）の行けない曜日のビット（1<<曜日）
function weekdayGroups(dates) {
  const cnt = new Array(7).fill(0);
  for (const d of dates) cnt[wdOf(d)]++;
  return cnt;
}
// 番号ごとの回数（targets）を決める: 埋まる枠を最大にし、その中で回数の差が最小・同じ差なら番号の小さい方を多く
function planCounts(dates, perDay, members, mask) {
  const cnt = weekdayGroups(dates);
  const S = 0, T = 1, P = (n) => 1 + n, G = (w) => 2 + members + w;
  const build = (cap) => {
    const f = new Flow(9 + members + 1);
    const src = [];
    for (let n = 1; n <= members; n++) {
      src[n] = f.add(S, P(n), cap(n));
      for (let w = 0; w < 7; w++) if (cnt[w] && !(mask[n] & (1 << w))) f.add(P(n), G(w), cnt[w]);
    }
    for (let w = 0; w < 7; w++) if (cnt[w]) f.add(G(w), T, cnt[w] * perDay);
    return { f, src };
  };
  const slots = dates.length * perDay;
  const fill = build(() => slots).f.max(S, T);
  if (!fill) return { targets: new Array(members + 1).fill(0), fill, slots };
  // 回数の上限 hi の最小と、下限 lo の最大を二分探索で決める（両方を同時に満たす割り当てがある）
  let a = Math.ceil(fill / members), b = fill;
  while (a < b) { const m = (a + b) >> 1; if (build(() => m).f.max(S, T) === fill) b = m; else a = m + 1; }
  const hi = a;
  // lo で全員を埋め、上限を1ずつ番号の小さい順に上げて fill まで足す
  const raise = (lo) => {
    const { f, src } = build(() => lo);
    let got = f.max(S, T);
    if (got !== lo * members) return null;
    for (let c = lo + 1; c <= hi && got < fill; c++) {
      for (let n = 1; n <= members && got < fill; n++) { src[n].cap += 1; got += f.max(S, T); }
    }
    return got === fill ? src : null;
  };
  let l = 0, r = Math.min(hi, Math.floor(fill / members));
  while (l < r) { const m = (l + r + 1) >> 1; if (raise(m)) l = m; else r = m - 1; }
  const targets = [0];
  const src = raise(l);
  for (let n = 1; n <= members; n++) targets[n] = src[n].rev.cap;
  return { targets, fill, slots };
}

// 残りの回数 rem を、date i（今日の空き todayLeft・今日に入っている番号 today）と i より後ろの日で受けきれるか
function feasible(dates, i, perDay, members, mask, rem, today, todayLeft) {
  const cnt = new Array(7).fill(0);
  for (let j = i + 1; j < dates.length; j++) cnt[wdOf(dates[j])]++;
  const wi = wdOf(dates[i]);
  const S = 0, T = 1, P = (n) => 1 + n, G = (w) => 2 + members + w, D = 9 + members;
  const f = new Flow(D + 1);
  let need = 0;
  for (let n = 1; n <= members; n++) {
    if (!rem[n]) continue;
    need += rem[n];
    f.add(S, P(n), rem[n]);
    for (let w = 0; w < 7; w++) if (cnt[w] && !(mask[n] & (1 << w))) f.add(P(n), G(w), cnt[w]);
    if (todayLeft > 0 && !(mask[n] & (1 << wi)) && !today.includes(n)) f.add(P(n), D, 1);
  }
  for (let w = 0; w < 7; w++) if (cnt[w]) f.add(G(w), T, cnt[w] * perDay);
  if (todayLeft > 0) f.add(D, T, todayLeft);
  return f.max(S, T) === need;
}

// 表を作る。dates: 当番の日（ISO・昇順）、unavailable: { 番号: [曜日(0=日)...] }
// 返す slots[i] は dates[i] の担当の番号（長さ perDay・0 は空き）
export function solveRota({ dates, perDay, members, unavailable = {} }) {
  const mask = maskOf(members, unavailable);
  const { targets, fill, slots: total } = planCounts(dates, perDay, members, mask);
  const rem = targets.slice();
  const done = new Array(members + 1).fill(0);
  const slots = [];
  let prev = [];
  for (let i = 0; i < dates.length; i++) {
    const w = wdOf(dates[i]);
    const today = [];
    for (let k = 0; k < perDay; k++) {
      const cands = [];
      for (let n = 1; n <= members; n++) if (rem[n] > 0 && !(mask[n] & (1 << w)) && !today.includes(n)) cands.push(n);
      // 前の日に入った番号は後ろ・回数の進み（(済み+0.5)/目標）の小さい順・同じなら番号の小さい順
      cands.sort((a, b) => (prev.includes(a) - prev.includes(b))
        || ((done[a] + 0.5) / targets[a] - (done[b] + 0.5) / targets[b])
        || (a - b));
      let pick = 0;
      for (const n of cands) {
        rem[n]--; today.push(n);
        if (feasible(dates, i, perDay, members, mask, rem, today, perDay - today.length)) { pick = n; break; }
        rem[n]++; today.pop();
      }
      if (!pick) break;
      done[pick]++;
    }
    while (today.length < perDay) today.push(0);
    slots.push(today);
    prev = today;
  }
  return { slots, targets, fill, total };
}

export function maskOf(members, unavailable = {}) {
  const mask = new Array(members + 1).fill(0);
  for (const [k, ws] of Object.entries(unavailable || {})) {
    const n = +k;
    if (!Number.isInteger(n) || n < 1 || n > members) continue;
    for (const w of ws || []) if (Number.isInteger(w) && w >= 0 && w <= 6) mask[n] |= 1 << w;
  }
  return mask;
}

// 表の点検: 空き枠・行けない曜日の違反・同じ日に同じ番号・回数と差
export function checkRota({ dates, slots, members, unavailable = {} }) {
  const mask = maskOf(members, unavailable);
  const counts = new Array(members + 1).fill(0);
  const empty = [], violations = [], dups = [];
  dates.forEach((d, i) => {
    const w = wdOf(d);
    const seen = new Set();
    (slots[i] || []).forEach((n, k) => {
      if (!n) { empty.push({ iso: d, slot: k }); return; }
      if (n > members) { violations.push({ iso: d, slot: k, n, kind: 'range' }); return; }
      counts[n]++;
      if (mask[n] & (1 << w)) violations.push({ iso: d, slot: k, n, kind: 'weekday' });
      if (seen.has(n)) dups.push({ iso: d, slot: k, n });
      seen.add(n);
    });
  });
  const cs = counts.slice(1);
  const min = cs.length ? Math.min(...cs) : 0, max = cs.length ? Math.max(...cs) : 0;
  const spread = max - min;
  const blocked = empty.length > 0 || violations.length > 0 || dups.length > 0;
  return { counts, min, max, spread, empty, violations, dups, blocked, skewed: !blocked && spread >= 2, ok: !blocked && spread < 2 };
}

// 前の版 → 今の版で変わった枠（日付・前の番号・新しい番号）と、番号ごとの追加・削除
export function diffRota(base, cur) {
  const map = (t) => { const m = new Map(); t.dates.forEach((d, i) => m.set(d, (t.slots[i] || []).filter(Boolean))); return m; };
  const a = map(base), b = map(cur);
  const all = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes = [];
  for (const d of all) {
    const x = (a.get(d) || []).slice(), y = (b.get(d) || []).slice();
    const out = x.filter((n) => !y.includes(n)), inn = y.filter((n) => !x.includes(n));
    for (let k = 0; k < Math.max(out.length, inn.length); k++) changes.push({ iso: d, from: out[k] || 0, to: inn[k] || 0 });
  }
  return changes;
}
export function memberChanges(changes, n) {
  return {
    added: changes.filter((c) => c.to === n).map((c) => c.iso),
    removed: changes.filter((c) => c.from === n).map((c) => c.iso),
  };
}
export const memberDates = (t, n) => t.dates.filter((d, i) => (t.slots[i] || []).includes(n));

// ---- 共有のリンク（URL の # 以降）----
// t=題 v=版 k=1回の人数 n=番号の数 i=表の id s=最初の日 d=日の間隔（36進・.区切り） a=担当（2桁の36進・00は空き）
// c=前の版から変わった枠（日のずれ-前の番号-新しい番号・.区切り）。氏名・行けない曜日・条件は入れない
const b36 = (n) => n.toString(36);
const two = (n) => n.toString(36).padStart(2, '0');
export function encodeShare(t) {
  const s = t.dates[0] || '';
  const d = t.dates.map((x, i) => b36(i ? daysBetween(t.dates[i - 1], x) : 0)).join('.');
  const a = t.slots.map((row) => row.map(two).join('')).join('');
  const c = (t.changes || []).map((x) => `${b36(daysBetween(s, x.iso) + 400)}-${b36(x.from)}-${b36(x.to)}`).join('.');
  const p = new URLSearchParams();
  p.set('t', String(t.title || '').slice(0, LIMITS.title));
  p.set('v', String(t.ver));
  p.set('k', String(t.perDay));
  p.set('n', String(t.members));
  p.set('i', String(t.id || ''));
  p.set('s', s.replace(/-/g, ''));
  p.set('d', d);
  p.set('a', a);
  if (c) p.set('c', c);
  return p.toString();
}
export function decodeShare(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (!p.has('a') || !p.has('s')) return null;
  const ver = +p.get('v'), perDay = +p.get('k'), members = +p.get('n');
  if (!Number.isInteger(ver) || ver < 1 || ver > 999) return null;
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > LIMITS.perDay) return null;
  if (!Number.isInteger(members) || members < 1 || members > LIMITS.members) return null;
  const sm = /^(\d{4})(\d{2})(\d{2})$/.exec(p.get('s'));
  const s = sm && parseIso(`${sm[1]}-${sm[2]}-${sm[3]}`);
  if (!s) return null;
  const steps = (p.get('d') || '').split('.').filter((x) => x !== '');
  if (!steps.length || steps.some((x) => !/^[0-9a-z]{1,3}$/.test(x))) return null;
  const dates = [];
  let cur = s;
  for (let i = 0; i < steps.length; i++) {
    const k = parseInt(steps[i], 36);
    if (i === 0 ? k !== 0 : k < 1) return null;
    cur = addDaysIso(cur, k);
    dates.push(cur);
  }
  if (daysBetween(dates[0], dates[dates.length - 1]) >= LIMITS.spanDays) return null;
  const a = p.get('a') || '';
  if (a.length !== dates.length * perDay * 2 || !/^[0-9a-z]*$/.test(a)) return null;
  const slots = dates.map((_, i) => Array.from({ length: perDay }, (_, k) => parseInt(a.substr((i * perDay + k) * 2, 2), 36)));
  if (slots.some((r) => r.some((n) => n > members))) return null;
  const changes = [];
  for (const x of (p.get('c') || '').split('.').filter(Boolean)) {
    const m = /^([0-9a-z]{1,3})-([0-9a-z]{1,2})-([0-9a-z]{1,2})$/.exec(x);
    if (!m) return null;
    const iso = addDaysIso(s, parseInt(m[1], 36) - 400), from = parseInt(m[2], 36), to = parseInt(m[3], 36);
    if (from > members || to > members || (!from && !to)) return null;
    changes.push({ iso, from, to });
  }
  const id = (p.get('i') || '').replace(/[^0-9a-z]/g, '').slice(0, 12);
  const title = (p.get('t') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LIMITS.title);
  return { title, ver, perDay, members, id, dates, slots, changes };
}

// ---- カレンダー（.ics）----
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
export function eventName(t, n, lang = 'ja') {
  const title = t.title || (lang === 'en' ? 'Duty' : '当番');
  return lang === 'en' ? `${title} (No. ${n}, version ${t.ver})` : `${title}（${n}番・第${t.ver}版）`;
}
export function icsFileName(t, n, kind) {
  return `toban-no${n}-v${t.ver}${kind === 'added' ? '-added' : ''}.ics`;
}
// dates: 予定にする日（ISO）。now: DTSTAMP に使う時刻（Date）
export function makeIcs(t, n, dates, { lang = 'ja', now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First CH Tools//toban//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const d of dates) {
    const ymd = d.replace(/-/g, '');
    lines.push('BEGIN:VEVENT',
      `UID:${t.id || 'toban'}-${ymd}-${n}@tools.first-ch.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${addDaysIso(d, 1).replace(/-/g, '')}`,
      fold(`SUMMARY:${icsText(eventName(t, n, lang))}`),
      'TRANSP:TRANSPARENT',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
// ==================== ここまでコア ====================

// ---- MCP の入口 ----
export class MakeRotaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const SITE = { ja: 'https://tools.first-ch.com/toban/', en: 'https://tools.first-ch.com/en/toban/' };
const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

function hashOf(link) {
  const s = String(link || '');
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(i + 1) : s;
}
function unavailableOf(opts, members) {
  const out = {};
  const src = opts.unavailable || {};
  for (const [k, ws] of Object.entries(src)) {
    const n = Number(k);
    if (!intIn(n, 1, members)) throw new MakeRotaError('BAD_MEMBER', `unavailable: member ${k} is not between 1 and ${members}`);
    if (!Array.isArray(ws) || ws.some((w) => !intIn(w, 0, 6))) throw new MakeRotaError('BAD_WEEKDAY', 'unavailable: weekdays must be integers 0 (Sun) to 6 (Sat)');
    if (ws.length) out[n] = [...new Set(ws)].sort();
  }
  return out;
}

// opts: { start, end, weekdays, perDay, members, unavailable, exclude, title, baseLink, swaps, member, lang, now, id }
export function makeRotaTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  let table, base = null, built = null;
  if (opts.baseLink) {
    const lt = decodeShare(hashOf(opts.baseLink));
    if (!lt) throw new MakeRotaError('BAD_LINK', 'base_link could not be read (pass the share link or the part after #)');
    base = lt;
    table = { ...lt, slots: lt.slots.map((r) => r.slice()) };
    if (opts.title != null) table.title = String(opts.title).slice(0, LIMITS.title);
  } else {
    if (opts.swaps && opts.swaps.length) throw new MakeRotaError('SWAPS_NEED_BASE', 'swaps needs base_link (the link of the version you sent before)');
    const members = opts.members;
    if (!intIn(members, 2, LIMITS.members)) throw new MakeRotaError('BAD_MEMBERS', `members must be an integer from 2 to ${LIMITS.members}`);
    const perDay = opts.perDay ?? 1;
    if (!intIn(perDay, 1, Math.min(LIMITS.perDay, members))) throw new MakeRotaError('BAD_PER_DAY', `per_day must be from 1 to ${Math.min(LIMITS.perDay, members)}`);
    const start = parseIso(opts.start), end = parseIso(opts.end);
    if (!start || !end) throw new MakeRotaError('BAD_DATE', 'start and end must be dates like 2026-12-01');
    const weekdays = opts.weekdays ?? [1, 2, 3, 4, 5];
    if (!Array.isArray(weekdays) || weekdays.some((w) => !intIn(w, 0, 6))) throw new MakeRotaError('BAD_WEEKDAY', 'weekdays must be integers 0 (Sun) to 6 (Sat)');
    const ex = parseExcludes(Array.isArray(opts.exclude) ? opts.exclude.join(' ') : (opts.exclude || ''), start, end);
    if (ex.bad.length) throw new MakeRotaError('BAD_EXCLUDE', `exclude could not be read: ${ex.bad.join(' ')}`);
    built = buildDates({ start, end, weekdays, exclude: ex.dates, lang });
    if (built.error) throw new MakeRotaError(built.error, { END_BEFORE_START: 'end is before start', TOO_LONG: `the period can be up to ${LIMITS.spanDays} days`, NO_WEEKDAY: 'choose at least one weekday', BAD_DATE: 'bad date' }[built.error]);
    const unavailable = unavailableOf(opts, members);
    const r = solveRota({ dates: built.dates, perDay, members, unavailable });
    const id = typeof opts.id === 'string' && /^[0-9a-z]{1,12}$/.test(opts.id) ? opts.id : randomBytes(4).toString('hex').slice(0, 6);
    table = { title: String(opts.title ?? (lang === 'en' ? 'Duty' : '当番')).slice(0, LIMITS.title), ver: 1, perDay, members, id, dates: built.dates, slots: r.slots, changes: [] };
  }
  const unavailable = unavailableOf(opts, table.members);
  // 交代: その日の from の枠を to へ（from を省くと1回1人の日だけ）
  for (const [k, s] of (opts.swaps || []).entries()) {
    const d = parseIso(s && s.date);
    const i = d ? table.dates.indexOf(d) : -1;
    if (i < 0) throw new MakeRotaError('BAD_SWAP', `swaps[${k}].date is not a duty day in the rota`);
    if (!intIn(s.to, 0, table.members)) throw new MakeRotaError('BAD_SWAP', `swaps[${k}].to must be a member number (0 = empty)`);
    let slot;
    if (s.from == null) {
      if (table.perDay !== 1) throw new MakeRotaError('BAD_SWAP', `swaps[${k}].from is needed when there is more than one person per day`);
      slot = 0;
    } else {
      slot = table.slots[i].indexOf(s.from);
      if (slot < 0) throw new MakeRotaError('BAD_SWAP', `swaps[${k}]: number ${s.from} is not on ${d}`);
    }
    table.slots[i][slot] = s.to;
  }
  if (base) {
    const ch = diffRota(base, table);
    table.changes = ch.length ? ch : base.changes;
    table.ver = ch.length ? base.ver + 1 : base.ver;
  }
  const check = checkRota({ dates: table.dates, slots: table.slots, members: table.members, unavailable });
  const status = check.blocked ? 'blocked' : check.skewed ? 'skewed' : 'ok';
  const perMember = {};
  if (table.ver > 1) {
    for (const n of [...new Set(table.changes.flatMap((x) => [x.from, x.to]).filter(Boolean))].sort((a, b) => a - b)) perMember[n] = memberChanges(table.changes, n);
  }
  const out = {
    title: table.title,
    version: table.ver,
    perDay: table.perDay,
    members: table.members,
    status,
    statusNote: {
      ok: lang === 'en' ? 'Ready to send: no empty slots, no rule breaks, counts within one.' : '配れる表（空き・違反なし、回数差1以内）。',
      skewed: lang === 'en' ? `Uneven (counts ${check.min}–${check.max}): a person should check before sending.` : `偏りあり・要確認（回数 ${check.min}〜${check.max}）。人が確かめてから配る。`,
      blocked: lang === 'en' ? 'Cannot be sent: there are empty slots or rule breaks.' : '配れない表（空きか違反がある）。',
    }[status],
    rota: table.dates.map((d, i) => {
      const row = { date: d, weekday: (lang === 'en' ? WD_EN : WD_JA)[wdOf(d)], members: table.slots[i].filter(Boolean) };
      if (table.slots[i].includes(0)) row.empty = table.slots[i].filter((n) => !n).length;
      if (+d.slice(0, 4) > HOLIDAY_TO) row.holidayUnchecked = true;
      return row;
    }),
    counts: Object.fromEntries(check.counts.map((c, n) => [n, c]).slice(1)),
    spread: check.spread,
    empty: check.empty.map((x) => x.iso),
    violations: [...check.violations.map((x) => ({ date: x.iso, member: x.n, kind: x.kind })), ...check.dups.map((x) => ({ date: x.iso, member: x.n, kind: 'twice' }))],
    changes: table.ver > 1 ? table.changes.map((x) => ({ date: x.iso, from: x.from || null, to: x.to || null })) : [],
    perMember,
    shareUrl: `${SITE[lang]}#${encodeShare(table)}`,
    holidayData: { source: HOLIDAY_SOURCE.name[lang], url: HOLIDAY_SOURCE.url, to: HOLIDAY_SOURCE.to },
  };
  if (built) {
    out.holidaysSkipped = built.holidays.map((h) => ({ date: h.iso, name: h.name }));
    out.excluded = built.excluded;
    out.holidayUncheckedDates = built.unknown;
  }
  if (opts.member != null) {
    if (!intIn(opts.member, 1, table.members)) throw new MakeRotaError('BAD_MEMBER', `member must be from 1 to ${table.members}`);
    const n = opts.member;
    const dates = table.ver === 1 ? memberDates(table, n) : memberChanges(table.changes, n).added;
    const kind = table.ver === 1 ? 'all' : 'added';
    out.ics = {
      member: n,
      kind,
      dates,
      removeDates: table.ver === 1 ? [] : memberChanges(table.changes, n).removed,
      fileName: icsFileName(table, n, kind),
      content: makeIcs(table, n, dates, { lang, now: opts.now instanceof Date ? opts.now : new Date() }),
    };
  }
  out.note = lang === 'en'
    ? 'The share link holds only numbers and dates (no names, no weekdays people cannot do). People open it, pick their number and get an .ics of their days (version 1) or of only the added days plus the days to delete. Calendars are never changed or deleted automatically.'
    : '共有リンクには番号と日付だけが入る（氏名・行けない曜日は入れない）。開いた人は自分の番号を選び、初版は当番日の .ics、改訂版は追加された日だけの .ics と消す日の一覧を受け取る。カレンダーの自動の変更・削除はしない。';
  out.url = SITE[lang];
  return out;
}
