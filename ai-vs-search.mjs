/* AIから来た人は検索より読む？（ai_vs_search）
 * 集計のコアは FirstCHTools の site/ai-vs-search/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/ai-vs-search/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' ai-vs-search.mjs)
 *
 * GA4「トラフィック獲得」（セッションのデフォルト チャネル グループ）の CSV を読み、Google が分類した AI Assistant と
 * Organic Search、それ以外の合計を、エンゲージメント率・平均エンゲージメント時間・キーイベント率（キーイベント÷セッション）で並べる。
 * 総計行は足さず突き合わせにだけ使う。外部の調査値・独自の AI サービスの一覧は使わない。完全ローカル処理・ネットワーク送信なし。 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// ===== ここからコア =====
export const AI_MIN_SESSIONS = 30;              // これ未満の AI Assistant は倍率を出さない
export const AI_CHANNEL_SINCE = '2026-05-13';   // GA4 のデフォルト チャネル グループに AI Assistant が加わった日
export const MAX_CSV_CHARS = 5000000;

export class AiVsSearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/^﻿/, '').replace(/[\s　"]/g, '').toLowerCase();

/** CSV（RFC 4180 の引用符・"" のエスケープ・引用符の中の改行）を行に分ける。line は行の始まりの物理行（1から） */
export function parseCsv(text, delim) {
  const src = String(text).replace(/^﻿/, '');
  const d = delim || sniffDelimiter(src);
  const rows = [];
  let cells = [], cell = '', q = false, line = 1, start = 1, i = 0, quoted = false;
  const push = () => { cells.push(quoted ? cell : cell.trim()); cell = ''; quoted = false; };
  const end = () => { push(); rows.push({ line: start, cells }); cells = []; };
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      if (c === '\r' || c === '\n') { line++; if (c === '\r' && src[i + 1] === '\n') i++; cell += '\n'; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell.trim() === '') { q = true; quoted = true; cell = ''; i++; continue; }
    if (c === d) { push(); i++; continue; }
    if (c === '\r' || c === '\n') { end(); if (c === '\r' && src[i + 1] === '\n') i++; i++; line++; start = line; continue; }
    cell += c; i++;
  }
  if (cell !== '' || cells.length || quoted) end();
  return rows;
}

function sniffDelimiter(src) {
  const first = src.split(/\r\n|\r|\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  return (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
}

// 列名（NFKC・空白なし・小文字で比べる）。日本語と英語の GA4 の表示名と、以前の名前（コンバージョン）を受け付ける
function colKind(name) {
  const n = norm(name);
  if (!n) return null;
  if (/チャネルグループ|channelgroup/.test(n)) return /最初のユーザー|firstuser/.test(n) ? 'userChannel' : 'channel';
  if (n === 'セッション' || n === 'セッション数' || n === 'sessions') return 'sessions';
  if (n === 'エンゲージのあったセッション数' || n === 'エンゲージのあったセッション' || n === 'engagedsessions') return 'engaged';
  if (n === 'セッションあたりの平均エンゲージメント時間' || n === 'averageengagementtimepersession') return 'avgTime';
  if (/^(キーイベント|keyevents|コンバージョン|conversions)/.test(n) && !/率|あたり|rate|per/.test(n)) return 'keyEvents';
  return null;
}

/** 数（"1,234"・"12.5"）。空・記号だけ・負の数は NaN */
export function parseCount(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** 平均エンゲージメント時間を秒で。"45.2"（秒）・"1m 05s"・"1分05秒"・"0:01:05"・"01:05" */
export function parseSeconds(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').trim().toLowerCase().replace(/,/g, '');
  if (!t) return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  let m = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (m) return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  m = t.replace(/\s+/g, '').match(/^(?:(\d+)(?:h|時間))?(?:(\d+)(?:m|min|分))?(?:(\d+(?:\.\d+)?)(?:s|sec|秒))?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return NaN;
}

const TOTAL_NAMES = new Set(['', 'grandtotal', 'total', 'totals', '総計', '合計', '全体']);
/** チャネル名を ai / search / other に。Google が付けた名前（AI Assistant・Organic Search）だけで分ける */
export function channelGroup(name) {
  const n = norm(name);
  if (n === 'aiassistant' || n === 'aiアシスタント') return 'ai';
  if (n === 'organicsearch' || n === 'オーガニック検索') return 'search';
  return 'other';
}

// 先頭のコメント行（# 開始日: 20261001 / # Start date: 20261001）から期間を読む
function readPeriod(rows) {
  let start = null, end = null;
  for (const r of rows) {
    const s = r.cells.join(',').normalize('NFKC');
    if (!s.trim().startsWith('#')) continue;
    const m = s.match(/(開始日|startdate|終了日|enddate)\s*[:：]\s*(\d{4})[-/]?(\d{2})[-/]?(\d{2})/i) || s.replace(/\s+/g, '').match(/(開始日|startdate|終了日|enddate)[:：](\d{4})[-/]?(\d{2})[-/]?(\d{2})/i);
    if (!m) continue;
    const d = m[2] + '-' + m[3] + '-' + m[4];
    if (/開始|start/i.test(m[1])) start = start || d; else end = end || d;
  }
  return { start, end };
}

const emptyGroup = () => ({ sessions: 0, engaged: 0, timeSum: 0, keyEvents: 0, rows: 0, channels: [] });

/**
 * GA4 のトラフィック獲得の CSV を集計する（ai_vs_search）。
 * 返り値の数は CSV の中の数だけから作り、外部の調査値は使わない。総計行は足さず、明細の合計との突き合わせにだけ使う。
 */
export function aiVsSearch(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AiVsSearchError('EMPTY', 'CSV is empty');
  if (text.length > MAX_CSV_CHARS) throw new AiVsSearchError('TOO_LARGE', 'CSV is larger than ' + MAX_CSV_CHARS + ' characters');
  const rows = parseCsv(text);
  const period = readPeriod(rows);
  // 見出し行: チャネル グループの列とセッションの列がある最初の行
  let hi = -1, cols = null, userChannel = false;
  for (let i = 0; i < rows.length; i++) {
    const kinds = rows[i].cells.map(colKind);
    if (kinds.includes('userChannel') && kinds.includes('sessions')) userChannel = true;
    if (kinds.includes('channel') && kinds.includes('sessions')) {
      cols = {};
      kinds.forEach((k, j) => { if (k && cols[k] == null) cols[k] = j; });
      hi = i; break;
    }
  }
  if (hi < 0) throw new AiVsSearchError(userChannel ? 'USER_ACQUISITION' : 'NO_HEADER', userChannel
    ? 'this looks like the User acquisition report; export Traffic acquisition (Session default channel group) instead'
    : 'no header row with a channel group column and a Sessions column');
  const width = rows[hi].cells.length;
  const groups = { ai: emptyGroup(), search: emptyGroup(), other: emptyGroup() };
  const excluded = [], seen = new Map(), totals = [];
  const read = { sessions: 0, engaged: 0, keyEvents: 0, rows: 0 };
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const first = (r.cells[0] || '').trim();
    if (r.cells.every((c) => !String(c).trim())) break;           // 空行で表が終わる
    if (first.startsWith('#')) break;                             // 次のコメント（別の表）
    if (r.cells.length !== width) { excluded.push({ line: r.line, reason: 'columns', name: (r.cells[cols.channel] || '').slice(0, 60) }); continue; }
    const name = String(r.cells[cols.channel]).trim();
    const sessions = parseCount(r.cells[cols.sessions]);
    const engaged = cols.engaged == null ? NaN : parseCount(r.cells[cols.engaged]);
    const avg = cols.avgTime == null ? NaN : parseSeconds(r.cells[cols.avgTime]);
    const key = cols.keyEvents == null ? NaN : parseCount(r.cells[cols.keyEvents]);
    const bad = !Number.isFinite(sessions) || (cols.engaged != null && !Number.isFinite(engaged))
      || (cols.avgTime != null && !Number.isFinite(avg)) || (cols.keyEvents != null && !Number.isFinite(key));
    if (TOTAL_NAMES.has(norm(name))) {
      if (!bad) totals.push({ line: r.line, sessions, engaged, keyEvents: key });
      else excluded.push({ line: r.line, reason: 'number', name: name.slice(0, 60) });
      continue;
    }
    if (bad) { excluded.push({ line: r.line, reason: 'number', name: name.slice(0, 60) }); continue; }
    if (Number.isFinite(engaged) && engaged > sessions) { excluded.push({ line: r.line, reason: 'engagedOverSessions', name: name.slice(0, 60) }); continue; }
    const g = groups[channelGroup(name)];
    g.sessions += sessions; g.rows++;
    if (Number.isFinite(engaged)) g.engaged += engaged;
    if (Number.isFinite(avg)) g.timeSum += avg * sessions;
    if (Number.isFinite(key)) g.keyEvents += key;
    if (!g.channels.includes(name)) g.channels.push(name);
    seen.set(norm(name), (seen.get(norm(name)) || 0) + 1);
    read.sessions += sessions; read.rows++;
    if (Number.isFinite(engaged)) read.engaged += engaged;
    if (Number.isFinite(key)) read.keyEvents += key;
  }
  if (!read.rows) throw new AiVsSearchError('NO_ROWS', 'no readable channel rows under the header');
  const has = { engaged: cols.engaged != null, avgTime: cols.avgTime != null, keyEvents: cols.keyEvents != null };
  const metric = (g) => ({
    sessions: g.sessions,
    engagedSessions: has.engaged ? g.engaged : null,
    engagementRate: has.engaged && g.sessions ? g.engaged / g.sessions : null,
    avgEngagementTime: has.avgTime && g.sessions ? g.timeSum / g.sessions : null,
    keyEvents: has.keyEvents ? g.keyEvents : null,
    keyEventRate: has.keyEvents && g.sessions ? g.keyEvents / g.sessions : null,
    rows: g.rows,
    channels: g.channels,
  });
  const out = { ai: metric(groups.ai), search: metric(groups.search), other: metric(groups.other) };
  // 総計との突き合わせ（1未満の差は丸めとみなす）
  const total = totals[0] || null;
  const near = (a, b) => !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < 1;
  const totalMatches = total ? near(total.sessions, read.sessions) && (!has.engaged || near(total.engaged, read.engaged)) && (!has.keyEvents || near(total.keyEvents, read.keyEvents)) : null;
  const basis = excluded.length || totalMatches === false ? 'read' : total ? 'matched' : 'noTotal';
  // 倍率（AI ÷ 検索）。AI が30セッション未満・検索の値が0のときは出さない
  const enough = out.ai.sessions >= AI_MIN_SESSIONS;
  const ratio = (k) => enough && out.search.sessions > 0 && out.ai[k] != null && out.search[k] ? out.ai[k] / out.search[k] : null;
  const ratios = { engagementRate: ratio('engagementRate'), avgEngagementTime: ratio('avgEngagementTime'), keyEventRate: ratio('keyEventRate') };
  const notes = [];
  if (!period.start || !period.end) notes.push('periodUnknown');
  else if (period.end < AI_CHANNEL_SINCE) notes.push('allBeforeAiChannel');
  else if (period.start < AI_CHANNEL_SINCE) notes.push('beforeAiChannel');
  if (out.ai.sessions === 0) notes.push('aiZero');
  else if (!enough) notes.push('lowSample');
  if (out.search.sessions === 0) notes.push('searchZero');
  if ([...seen.values()].some((n) => n > 1) || totals.length > 1) notes.push('duplicate');
  if (!has.engaged) notes.push('noEngaged');
  if (!has.avgTime) notes.push('noAvgTime');
  if (!has.keyEvents) notes.push('noKeyEvents');
  return {
    ok: true,
    period,
    groups: out,
    ratios,
    lowSample: out.ai.sessions > 0 && !enough,
    aiZero: out.ai.sessions === 0,
    minSessions: AI_MIN_SESSIONS,
    totals: { basis, read, total: total ? { line: total.line, sessions: total.sessions, engagedSessions: has.engaged ? total.engaged : null, keyEvents: has.keyEvents ? total.keyEvents : null } : null, matches: totalMatches },
    excluded,
    notes,
    columns: { header: rows[hi].line, found: Object.keys(cols) },
  };
}

// ---- 文言（画面・共有画像・要約・MCP で共通） ----
export const T = {
  ja: {
    groups: { ai: 'AI Assistant', search: 'Organic Search', other: 'その他の合計' },
    groupSub: { ai: 'AIから', search: '検索から', other: 'Direct・Referral など' },
    metrics: { engagementRate: 'エンゲージメント率', avgEngagementTime: '平均エンゲージメント時間', keyEventRate: 'キーイベント率' },
    metricSub: { engagementRate: 'エンゲージのあったセッション÷セッション', avgEngagementTime: 'セッションあたり', keyEventRate: 'キーイベント÷セッション' },
    sessions: (n) => fmtInt(n, 'ja') + ' セッション',
    low: '件数が少なく参考値',
    basis: { matched: '合計（総計行と一致）', read: '読み取れた行の合計', noTotal: '明細の合計（CSVに総計行なし）' },
    reason: { columns: '列の数が見出しと違う', number: '数として読めない値がある', engagedOverSessions: 'エンゲージのあったセッションがセッションより多い' },
    excluded: (lines) => '除外した行: ' + lines.join('・') + ' 行目',
    ratio: (x) => '×' + fmtRatio(x),
    ratioLine: (m, x) => m + 'は検索の ' + fmtRatio(x) + ' 倍',
    noRatio: '倍率は出していません',
    period: (p) => p.start && p.end ? fmtDate(p.start, 'ja') + '〜' + fmtDate(p.end, 'ja') : '期間不明',
    notes: {
      periodUnknown: 'CSV の先頭に期間（開始日・終了日）が見つかりませんでした。2026年5月13日より前を含む場合、その日より前の AI からの訪問は AI Assistant に入っていない可能性があります。',
      allBeforeAiChannel: 'この期間はすべて2026年5月13日より前です。AI Assistant チャネルはこの日に GA4 に加わったため、AI からの訪問は Referral などに入っています。',
      beforeAiChannel: '期間に2026年5月13日より前が含まれます。AI Assistant チャネルはこの日に GA4 に加わったため、それより前の AI からの訪問は Referral などに入っている可能性があります。',
      aiZero: 'AI Assistant の行がありません（この期間の AI からの訪問が0か、表の行数を減らして書き出したかもしれません）。',
      lowSample: 'AI Assistant が30セッション未満のため、倍率は出さず、数は参考値です。',
      searchZero: 'Organic Search の行がないため、倍率は出していません。',
      duplicate: '同じチャネルが2行以上あります。比較やセカンダリ ディメンションを付けたまま書き出していないか確かめてください（各行はそのまま足しています）。',
      noEngaged: '「エンゲージのあったセッション数」の列がないため、エンゲージメント率は出していません。',
      noAvgTime: '「セッションあたりの平均エンゲージメント時間」の列がないため、平均エンゲージメント時間は出していません。',
      noKeyEvents: '「キーイベント」の列がないため、キーイベント率は出していません。',
    },
    fine: ['このCSV内の数値', '参照元が渡らないAI訪問とAI Overviewsは区別できない'],
    cardNote: { allBeforeAiChannel: 'AI Assistant は2026年5月13日から分類。この期間の AI からの訪問は Referral などに入っています', beforeAiChannel: 'AI Assistant は2026年5月13日から分類。それより前の AI からの訪問は Referral などに入っている可能性があります', periodUnknown: '期間不明。AI Assistant は2026年5月13日から分類されています' },
    fineLong: 'このCSV内の数値です。参照元が渡らない AI からの訪問（Direct などに入る）と、Google 検索の AI による概要（AI Overviews）・AI モードからの訪問（Organic Search に入る）は区別できません。',
    head: 'GA4 トラフィック獲得',
  },
  en: {
    groups: { ai: 'AI Assistant', search: 'Organic Search', other: 'All other channels' },
    groupSub: { ai: 'from AI', search: 'from search', other: 'Direct, Referral, etc.' },
    metrics: { engagementRate: 'Engagement rate', avgEngagementTime: 'Avg engagement time', keyEventRate: 'Key event rate' },
    metricSub: { engagementRate: 'engaged sessions ÷ sessions', avgEngagementTime: 'per session', keyEventRate: 'key events ÷ sessions' },
    sessions: (n) => fmtInt(n, 'en') + (n === 1 ? ' session' : ' sessions'),
    low: 'small sample, for reference only',
    basis: { matched: 'Total (matches the grand total row)', read: 'Total of the rows that could be read', noTotal: 'Total of the rows (no grand total row in the CSV)' },
    reason: { columns: 'column count differs from the header', number: 'a value is not a number', engagedOverSessions: 'more engaged sessions than sessions' },
    excluded: (lines) => 'Rows left out: line ' + lines.join(', '),
    ratio: (x) => '×' + fmtRatio(x),
    ratioLine: (m, x) => m + ' is ' + fmtRatio(x) + '× search',
    noRatio: 'No ratios shown',
    period: (p) => p.start && p.end ? fmtDate(p.start, 'en') + ' – ' + fmtDate(p.end, 'en') : 'Period unknown',
    notes: {
      periodUnknown: 'No period (start and end date) was found at the top of the CSV. If it covers dates before May 13, 2026, AI visits before that day may not be in AI Assistant.',
      allBeforeAiChannel: 'The whole period is before May 13, 2026. The AI Assistant channel was added to GA4 on that day, so AI visits here are in Referral and other channels.',
      beforeAiChannel: 'The period includes dates before May 13, 2026. The AI Assistant channel was added to GA4 on that day, so earlier AI visits may be in Referral and other channels.',
      aiZero: 'There is no AI Assistant row (no AI visits in this period, or the table was exported with fewer rows).',
      lowSample: 'AI Assistant has fewer than 30 sessions, so no ratios are shown and the numbers are for reference only.',
      searchZero: 'There is no Organic Search row, so no ratios are shown.',
      duplicate: 'The same channel appears on more than one row. Check that no comparison or secondary dimension was on when you exported (each row was added as is).',
      noEngaged: 'There is no Engaged sessions column, so engagement rate is not shown.',
      noAvgTime: 'There is no Average engagement time per session column, so engagement time is not shown.',
      noKeyEvents: 'There is no Key events column, so key event rate is not shown.',
    },
    fine: ['Numbers from this CSV only', 'AI visits without a referrer and AI Overviews cannot be told apart'],
    cardNote: { allBeforeAiChannel: 'AI Assistant is classified from May 13, 2026. AI visits in this period are in Referral and other channels', beforeAiChannel: 'AI Assistant is classified from May 13, 2026. Earlier AI visits may be in Referral and other channels', periodUnknown: 'Period unknown. AI Assistant is classified from May 13, 2026' },
    fineLong: 'Numbers from this CSV only. AI visits that pass no referrer (they land in Direct and others) and visits from Google’s AI Overviews and AI Mode (they land in Organic Search) cannot be told apart.',
    head: 'GA4 Traffic acquisition',
  },
};

export function fmtInt(n, lang) { return Number(n).toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP', { maximumFractionDigits: 0 }); }
export function fmtRatio(x) { return x >= 9.95 ? x.toFixed(0) : x.toFixed(1); }
export function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }
export function fmtTime(sec, lang) {
  if (sec == null) return '—';
  const s = Math.round(sec), m = Math.floor(s / 60), r = s % 60;
  if (lang === 'en') return m ? m + 'm ' + String(r).padStart(2, '0') + 's' : r + 's';
  return m ? m + '分' + String(r).padStart(2, '0') + '秒' : r + '秒';
}
export function fmtDate(d, lang) {
  const [y, m, dd] = d.split('-').map(Number);
  if (lang === 'en') return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] + ' ' + dd + ', ' + y;
  return y + '/' + String(m).padStart(2, '0') + '/' + String(dd).padStart(2, '0');
}
export function fmtMetric(k, v, lang) { return k === 'avgEngagementTime' ? fmtTime(v, lang) : fmtPct(v); }

export const METRIC_KEYS = ['engagementRate', 'avgEngagementTime', 'keyEventRate'];

/** 上司や制作会社へ貼る要約（プレーンテキスト） */
export function summaryText(r, lang = 'ja', url = 'https://tools.first-ch.com/ai-vs-search/') {
  const L = T[lang === 'en' ? 'en' : 'ja'];
  const lines = [L.head + ' ' + L.period(r.period)];
  for (const g of ['ai', 'search', 'other']) {
    const m = r.groups[g];
    const head = L.groups[g] + ': ' + L.sessions(m.sessions) + (g === 'ai' && r.lowSample ? '（' + L.low + '）' : '');
    lines.push(head + ' / ' + METRIC_KEYS.map((k) => L.metrics[k] + ' ' + fmtMetric(k, m[k], lang)).join(' / '));
  }
  const rs = METRIC_KEYS.filter((k) => r.ratios[k] != null).map((k) => L.ratioLine(L.metrics[k], r.ratios[k]));
  lines.push(rs.length ? (lang === 'en' ? 'AI vs search: ' : 'AI と検索の比: ') + rs.join(lang === 'en' ? ', ' : '・') : L.noRatio + '（' + (r.aiZero ? L.notes.aiZero : r.lowSample ? L.notes.lowSample : L.notes.searchZero) + '）');
  if (r.totals.basis !== 'matched') lines.push(L.basis[r.totals.basis] + ': ' + L.sessions(r.totals.read.sessions));
  if (r.excluded.length) lines.push(L.excluded(r.excluded.map((e) => e.line)));
  for (const n of r.notes) if (['periodUnknown', 'allBeforeAiChannel', 'beforeAiChannel', 'duplicate'].includes(n)) lines.push('※' + L.notes[n]);
  lines.push('※' + L.fineLong);
  if (url) lines.push(url);
  return lines.join('\n');
}

/** 見本の CSV（架空の数値・GA4 の書き出しと同じ並び）。lang で日本語版・英語版の見出しにする */
export function makeSampleCsv(lang = 'ja') {
  const ja = lang !== 'en';
  const head = ja
    ? ['# ----------------------------------------', '# トラフィック獲得: セッションのデフォルト チャネル グループ', '# アカウント: 見本', '# プロパティ: 見本の店（架空）', '# ----------------------------------------', '#', '# 開始日: 20261001', '# 終了日: 20261031',
      'セッションのデフォルト チャネル グループ,ユーザー,セッション,エンゲージのあったセッション数,セッションあたりの平均エンゲージメント時間,イベント数,キーイベント,合計収益']
    : ['# ----------------------------------------', '# Traffic acquisition: Session default channel group', '# Account: Sample', '# Property: Sample shop (fictional)', '# ----------------------------------------', '#', '# Start date: 20261001', '# End date: 20261031',
      'Session default channel group,Users,Sessions,Engaged sessions,Average engagement time per session,Event count,Key events,Total revenue'];
  const data = [
    [ja ? '総計' : 'Grand total', 4310, 6127, 3528, 58.4, 41262, 198, 0],
    ['Organic Search', 2105, 2948, 1797, 58.6, 20137, 91, 0],
    ['Direct', 1240, 1702, 811, 47.9, 9604, 52, 0],
    ['Referral', 402, 563, 343, 70.2, 4117, 20, 0],
    ['Organic Social', 337, 437, 189, 33.5, 2210, 6, 0],
    ['AI Assistant', 151, 214, 163, 112.8, 2385, 18, 0],
    ['Email', 61, 205, 178, 104.3, 2392, 10, 0],
    ['Unassigned', 14, 58, 47, 62.7, 417, 1, 0],
  ];
  return head.concat(data.map((r) => r.map((c, i) => i === 0 ? c : i === 1 || i === 2 || i === 5 ? '"' + Number(c).toLocaleString('en-US') + '"' : c).join(','))).join('\n') + '\n';
}
// ===== ここまでコア =====

// ---- MCP の入口 ----
export async function aiVsSearchTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  let text;
  if (typeof opts.csv === 'string' && opts.csv.trim()) text = opts.csv;
  else if (opts.path) {
    if (!path.isAbsolute(opts.path)) throw new AiVsSearchError('PATH_NOT_ABSOLUTE', 'path must be an absolute path');
    const st = await stat(opts.path).catch(() => null);
    if (!st || !st.isFile()) throw new AiVsSearchError('NOT_FOUND', 'file not found: ' + opts.path);
    if (st.size > MAX_CSV_CHARS * 4) throw new AiVsSearchError('TOO_LARGE', 'CSV file is too large');
    const buf = await readFile(opts.path);
    // GA4 の CSV は UTF-8。Excel で保存し直したものは UTF-16・Shift_JIS のことがあるので読み替える（サイト側の app.js と同じ順）
    if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf);
    else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('shift_jis').decode(buf); } }
  } else throw new AiVsSearchError('NO_INPUT', 'pass csv (text) or path (absolute)');
  const r = aiVsSearch(text);
  const L = T[lang];
  return {
    ...r,
    labels: { groups: L.groups, metrics: L.metrics, basis: L.basis[r.totals.basis] },
    noteTexts: r.notes.map((n) => L.notes[n]),
    excludedTexts: r.excluded.map((e) => ({ line: e.line, reason: L.reason[e.reason] })),
    caveat: L.fineLong,
    summary: summaryText(r, lang, lang === 'en' ? 'https://tools.first-ch.com/en/ai-vs-search/' : 'https://tools.first-ch.com/ai-vs-search/'),
  };
}
