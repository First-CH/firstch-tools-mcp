/* インボイス値下げ、応じる前に相手へ聞く3問チェック（invoice_nebiki_check）
 * 判定と文面のコアは FirstCHTools の site/invoice-nebiki/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/invoice-nebiki/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' invoice-nebiki.mjs)
 *
 * インボイス発行事業者でない側（個人の制作者など）が取引先から値下げを求められたとき、取引先の申告方式・個人か法人か・
 * 1回の請求が税込1万円未満かの3問から、時期別に「差あり（月額）・差なし・要確認」を返し、要確認の点だけを尋ねる確認文を作る。
 * 制度の数字（2026-11-05 確認）: 国税庁「インボイス制度に関する令和8年度税制改正について」・「少額特例の概要」。
 * 自分の納税額・登録の要否・違法かどうか・相手の方式や規模の推定・法人税等は扱わない。完全ローカル処理・ネットワーク送信なし。 */

// ===== ここからコア =====
export const METHODS = ['general', 'simplified', 'niwari', 'sanwari', 'exempt', 'unknown'];
export const PARTIES = ['individual', 'corporation'];
export const SMALLS = ['yes', 'no', 'unknown'];

// 時期の区切り（この日から）。pct は、登録事業者からの仕入れなら控除できた税額のうち、相手が控除できなくなる割合
// （経過措置で控除できる割合 80→70→50→30→0% の残り）。同じ pct が続く区切りは、特例の終わりで行を分けるためのもの
export const SEGMENTS = [
  { from: '2023-10-01', pct: 20 },
  { from: '2026-10-01', pct: 30 },
  { from: '2027-01-01', pct: 30 },   // 個人の2割特例は2026年分まで
  { from: '2027-10-01', pct: 30 },   // 法人の「2026年9月30日を含む課税期間」は遅くともこの前日までに終わる
  { from: '2028-10-01', pct: 50 },
  { from: '2029-01-01', pct: 50 },   // 個人の3割特例は2028年分まで
  { from: '2029-10-01', pct: 50 },   // 少額特例は2029年9月30日までの仕入れ
  { from: '2030-10-01', pct: 70 },
  { from: '2031-10-01', pct: 100 },
];

export class InvoiceNebikiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const T = {
  ja: {
    method: { general: '一般課税', simplified: '簡易課税', niwari: '2割特例', sanwari: '3割特例', exempt: '免税事業者・消費者', unknown: 'わからない' },
    party: { individual: '個人', corporation: '法人' },
    small: { yes: '税込1万円未満', no: '税込1万円以上', unknown: 'わからない' },
    status: { diff: '差あり', none: '差なし', check: '要確認' },
    recheck: '方式の再確認が必要',
    month: function (ym) { return Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月'; },
    range: function (a, b) { return a + '〜' + (b || ''); },
    yen: function (n) { return '月' + n.toLocaleString('ja-JP') + '円'; },
    pctOf: function (p) { return '税込額の約' + p + '%'; },
    note: {
      exempt: '相手は仕入税額控除をしないため、登録の有無で差は出ません（相手が課税事業者になれば変わります）。',
      simplified: '簡易課税は売上の税額から控除額を計算するため、登録の有無で差は出ません（相手が簡易課税を続ける間）。',
      niwari: '2割特例は売上の税額から納税額を計算するため、差は出ません。',
      niwari_end_ind: '2割特例は個人の2026年分まで。2027年分からの方式は相手への確認が必要です（簡易課税へ移ったとは仮定しません）。',
      niwari_corp_fy: '法人の2割特例は2026年9月30日を含む課税期間まで。その課税期間の末日までは差なし、その後は方式の再確認が必要です。',
      niwari_end_corp: '2026年9月30日を含む課税期間は終わっています。今の方式は相手への確認が必要です（簡易課税へ移ったとは仮定しません）。',
      sanwari_before: '3割特例は個人の2027年分からです。2026年分の方式は相手への確認が必要です。',
      sanwari: '3割特例は売上の税額から納税額を計算するため、差は出ません。',
      sanwari_end: '3割特例は2028年分まで。2029年分からの方式は相手への確認が必要です（簡易課税へ移ったとは仮定しません）。',
      sanwari_corp: '3割特例は個人事業者だけの特例です。法人である相手の方式は確認が必要です。',
      general: function (pct) { return (pct >= 100 ? '相手は税額を控除できず、全額が差になります' : '相手は税額の' + (100 - pct) + '%しか控除できず、' + pct + '%分の控除が減ります') + '（少額特例など全額控除できる取引を除いた概算）。'; },
      generalShort: function (pct) { return pct >= 100 ? '控除なし（経過措置の終了）' : '控除できるのは' + (100 - pct) + '%（経過措置）'; },
      small_yes: '1回が税込1万円未満の取引は、相手が少額特例（2029年9月30日まで）の対象なら全額控除でき差なし。対象かは相手の売上規模で決まるため確認が必要です。',
      small_unknown: '1回の請求が税込1万円未満かで変わります。1万円未満で、相手が少額特例の対象なら差なし。',
      method_unknown: '相手の方式で変わります。一般課税なら差あり、簡易課税・2割特例・3割特例・免税なら差なし。',
    },
    paren: function (s) { return '（' + s + '）'; },
    hint: function (amt, pctText) { return '一般課税で全額控除できない取引なら ' + (amt != null ? amt + '（' + pctText + '）' : pctText); },
    premises: [
      '概算です（税込10%の請求額から計算し、1円未満は切り捨て）。',
      '相手が登録事業者からの仕入れなら全額を控除でき、帳簿と請求書の保存要件を満たしている場合に限ります。',
      '法人税・所得税などへの影響は含めていません。',
      '特例（2割特例・3割特例・少額特例・簡易課税）を使えるかどうかは、相手が判断します。',
    ],
    premisesTitle: '前提',
    cut: {
      none: '言われた値下げを入れると、相手側の差と比べます。',
      needMonthly: '値下げを金額で比べるには、月の請求額を入れてください。',
      noDiff: function (cut) { return '言われた値下げは' + cut + '。今の時期、前提のもとで相手側の差は出ない見込みです。'; },
      check: function (cut) { return '言われた値下げは' + cut + '。要確認の点が分かるまで、相手側の差は確定しません。'; },
      ratio: function (cut, diff, r) { return '言われた値下げ（' + cut + '）は、相手側の差（' + diff + '）の約' + r + '倍です。'; },
      below: function (cut, diff) { return '言われた値下げ（' + cut + '）は、相手側の差（' + diff + '）より小さい額です。'; },
      same: function (cut, diff) { return '言われた値下げ（' + cut + '）は、相手側の差（' + diff + '）とほぼ同じです。'; },
      rate: function (r) { return '請求額の' + r + '%'; },
    },
    msg: {
      to: '（取引先名）様',
      hello: 'いつもお世話になっております。',
      askLead: '先日ご相談いただいたお支払い額の見直しについて、こちらでも影響を正しく把握したく、次の点を教えていただけますでしょうか。',
      askEnd: 'お答えいただいた内容をもとに、条件をあらためてご相談させてください。',
      tellLead: function (facts) { return '先日ご相談いただいたお支払い額の見直しについて、伺った内容（' + facts + '）をもとに整理しました。'; },
      tellEnd: '上の見込みを踏まえて、条件をご相談させてください。',
      rowDiff: function (label, v) { return label + '：差は' + v + 'の見込み'; },
      rowNone: function (label) { return label + '：差は出ない見込み'; },
      premiseHead: '当方の試算の前提',
      premises: [
        '概算です（税込10%の請求額から計算し、1円未満は切り捨て）。',
        '貴社が登録事業者からの仕入れなら全額を控除でき、帳簿と請求書の保存要件を満たしている場合に限ります。',
        '法人税・所得税などへの影響は含めていません。',
        '特例（2割特例・3割特例・少額特例・簡易課税）を使えるかどうかは、貴社のご判断によります。',
      ],
      q: {
        method_unknown: '貴社の消費税の申告方式は、一般課税・簡易課税・2割特例・3割特例のどれでしょうか（免税事業者の場合もお知らせください）。',
        small: '当方への1回のお支払いが税込1万円未満となる取引について、少額特例（インボイスがなくても帳簿の保存だけで全額控除できる、2029年9月30日までの特例）をお使いでしょうか。',
        niwari_ind: '2割特例は2026年分までと承知しています。2027年分以降の申告方式（3割特例・簡易課税・一般課税など）のご予定を教えてください。',
        niwari_corp: '2割特例は2026年9月30日を含む課税期間までと承知しています。その課税期間の末日と、その後の申告方式のご予定を教えてください。',
        sanwari_2026: '3割特例は2027年分・2028年分が対象と承知しています。2026年分の申告方式を教えてください。',
        sanwari_after: '3割特例は2028年分までと承知しています。2029年分以降の申告方式のご予定を教えてください。',
        sanwari_corp: '3割特例は個人事業者向けの特例と承知しています。貴社の申告方式をあらためて教えてください。',
      },
    },
  },
  en: {
    method: { general: 'Standard taxation', simplified: 'Simplified taxation', niwari: '20% special rule', sanwari: '30% special rule', exempt: 'Tax-exempt business / consumer', unknown: 'Not sure' },
    party: { individual: 'Sole proprietor', corporation: 'Corporation' },
    small: { yes: 'Under ¥10,000 incl. tax', no: '¥10,000 or more', unknown: 'Not sure' },
    status: { diff: 'Difference', none: 'No difference', check: 'To confirm' },
    recheck: 'Method must be reconfirmed',
    month: function (ym) { return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4); },
    range: function (a, b) { return b ? a + ' – ' + b : 'From ' + a; },
    yen: function (n) { return '¥' + n.toLocaleString('en-US') + '/month'; },
    pctOf: function (p) { return 'about ' + p + '% of the tax-inclusive amount'; },
    note: {
      exempt: 'They do not claim input tax credits, so your registration status makes no difference (this changes if they become a taxable business).',
      simplified: 'Simplified taxation computes the credit from their sales, so your registration status makes no difference (while they stay on it).',
      niwari: 'The 20% special rule computes tax from their sales, so there is no difference.',
      niwari_end_ind: 'The 20% special rule ends with tax year 2026 for sole proprietors. Ask which method they use from 2027 (we do not assume they moved to simplified taxation).',
      niwari_corp_fy: 'For corporations, the 20% special rule covers the tax period that includes Sep 30, 2026. No difference until that period ends; after that the method must be reconfirmed.',
      niwari_end_corp: 'The tax period that includes Sep 30, 2026 has ended. Ask which method they use now (we do not assume simplified taxation).',
      sanwari_before: 'The 30% special rule starts with tax year 2027 for sole proprietors. Ask which method they use for 2026.',
      sanwari: 'The 30% special rule computes tax from their sales, so there is no difference.',
      sanwari_end: 'The 30% special rule ends with tax year 2028. Ask which method they use from 2029 (we do not assume simplified taxation).',
      sanwari_corp: 'The 30% special rule is for sole proprietors only. Ask the corporation which method it uses.',
      general: function (pct) { return (pct >= 100 ? 'They can no longer credit the tax at all' : 'They can credit only ' + (100 - pct) + '% of the tax, losing ' + pct + '%') + ' (an estimate that excludes fully creditable purchases such as the small-amount rule).'; },
      generalShort: function (pct) { return pct >= 100 ? 'No credit (transitional measure ended)' : (100 - pct) + '% creditable (transitional measure)'; },
      small_yes: 'Purchases under ¥10,000 per transaction are fully creditable if they qualify for the small-amount rule (until Sep 30, 2029). Whether they qualify depends on their sales size, so ask.',
      small_unknown: 'It depends on whether one invoice is under ¥10,000 incl. tax. If it is and they qualify for the small-amount rule, there is no difference.',
      method_unknown: 'It depends on their method: a difference under standard taxation, none under simplified taxation, the 20%/30% rules or if exempt.',
    },
    paren: function (s) { return ' (' + s + ')'; },
    hint: function (amt, pctText) { return 'If standard taxation without full credit: ' + (amt != null ? amt + ' (' + pctText + ')' : pctText); },
    premises: [
      'This is an estimate (from tax-inclusive amounts at 10%, fractions of a yen cut off).',
      'It assumes they could fully credit purchases from a registered business and meet the bookkeeping and invoice requirements.',
      'Corporate and income tax effects are not included.',
      'Whether they can use a special rule (20%, 30%, small-amount, simplified) is their call.',
    ],
    premisesTitle: 'Assumptions',
    cut: {
      none: 'Enter the requested cut to compare it with their difference.',
      needMonthly: 'Enter the monthly invoice amount to compare a cut given in yen.',
      noDiff: function (cut) { return 'The requested cut is ' + cut + '. For now, under these assumptions, they see no difference.'; },
      check: function (cut) { return 'The requested cut is ' + cut + '. Their difference is not fixed until the open points are confirmed.'; },
      ratio: function (cut, diff, r) { return 'The requested cut of ' + cut + ' is about ' + r + '× their difference of ' + diff + '.'; },
      below: function (cut, diff) { return 'The requested cut of ' + cut + ' is smaller than their difference of ' + diff + '.'; },
      same: function (cut, diff) { return 'The requested cut of ' + cut + ' is about the same as their difference of ' + diff + '.'; },
      rate: function (r) { return r + '% of the invoice'; },
    },
    msg: {
      to: 'Dear (client name),',
      hello: 'Thank you for your continued business.',
      askLead: 'Regarding the price adjustment you mentioned, could you tell me the following so that I can understand the impact correctly?',
      askEnd: 'Based on your answers, I would like to discuss the terms again.',
      tellLead: function (facts) { return 'Regarding the price adjustment you mentioned, here is my estimate based on what you told me (' + facts + ').'; },
      tellEnd: 'I would like to discuss the terms with these figures in mind.',
      rowDiff: function (label, v) { return label + ': an estimated difference of ' + v; },
      rowNone: function (label) { return label + ': no difference expected'; },
      premiseHead: 'Assumptions behind my estimate',
      premises: [
        'This is an estimate (from tax-inclusive amounts at 10%, fractions of a yen cut off).',
        'It assumes you could fully credit purchases from a registered business and meet the bookkeeping and invoice requirements.',
        'Corporate and income tax effects are not included.',
        'Whether you can use a special rule (20%, 30%, small-amount, simplified) is your call.',
      ],
      q: {
        method_unknown: 'Which consumption tax method do you use: standard taxation, simplified taxation, the 20% special rule or the 30% special rule (or are you tax-exempt)?',
        small: 'For payments to me under ¥10,000 (tax included) per transaction, do you use the small-amount rule (full credit with books only, until Sep 30, 2029)?',
        niwari_ind: 'I understand the 20% special rule ends with tax year 2026. Which method do you plan to use from 2027 (30% rule, simplified, standard, etc.)?',
        niwari_corp: 'I understand the 20% special rule covers the tax period that includes Sep 30, 2026. When does that period end, and which method do you plan to use after it?',
        sanwari_2026: 'I understand the 30% special rule covers tax years 2027 and 2028. Which method do you use for 2026?',
        sanwari_after: 'I understand the 30% special rule ends with tax year 2028. Which method do you plan to use from 2029?',
        sanwari_corp: 'I understand the 30% special rule is for sole proprietors. Could you confirm which method your company uses?',
      },
    },
  },
};

// 問いの番号（同じ問いを2度聞かない）
var Q_OF = { method_unknown: 'method_unknown', small_yes: 'small', small_unknown: 'small', niwari_end_ind: 'niwari_ind', niwari_corp_fy: 'niwari_corp',
  niwari_end_corp: 'niwari_corp', sanwari_before: 'sanwari_2026', sanwari_end: 'sanwari_after', sanwari_corp: 'sanwari_corp' };

function pick(v, list, name) {
  if (v == null || v === '') return null;
  if (list.indexOf(v) < 0) throw new InvoiceNebikiError('INVALID_' + name.toUpperCase(), name + ' must be one of ' + list.join(', '));
  return v;
}

function isoDay(d) {
  if (d == null || d === '') { var n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new InvoiceNebikiError('INVALID_TODAY', 'today must be YYYY-MM-DD');
  return String(d);
}

function money(v, name) {
  if (v == null || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s円¥￥]/g, ''));
  if (!isFinite(n) || n < 0 || n > 1e10) throw new InvoiceNebikiError('INVALID_' + name.toUpperCase(), name + ' must be a yen amount between 0 and 10,000,000,000');
  n = Math.floor(n);
  return n > 0 ? n : null;
}

// 入力をそろえる（未入力は null。範囲外は InvoiceNebikiError）
export function normalizeInput(input) {
  var x = input || {};
  var cut = null;
  if (x.cut && x.cut.value != null && x.cut.value !== '') {
    var type = x.cut.type === 'amount' ? 'amount' : 'rate';
    if (type === 'rate') {
      var r = Number(String(x.cut.value).replace(/[%％\s]/g, ''));
      if (!isFinite(r) || r < 0 || r > 100) throw new InvoiceNebikiError('INVALID_CUT', 'cut rate must be between 0 and 100');
      if (r > 0) cut = { type: 'rate', value: Math.round(r * 100) / 100 };
    } else {
      var a = money(x.cut.value, 'cut');
      if (a) cut = { type: 'amount', value: a };
    }
  }
  var method = pick(x.method, METHODS, 'method') || 'unknown', party = pick(x.party, PARTIES, 'party');
  // 2割特例・3割特例は個人と法人で期限が違うので、どちらかが要る
  if (!party && (method === 'niwari' || method === 'sanwari')) throw new InvoiceNebikiError('PARTY_REQUIRED', 'party (individual or corporation) is required for the 20%/30% special rules');
  return {
    method: method,
    party: party,
    small: pick(x.small, SMALLS, 'small') || 'unknown',
    monthly: money(x.monthly, 'monthly'),
    cut: cut,
    today: isoDay(x.today),
  };
}

// 1つの区切りでの判定。status: diff（差あり）・none（差なし）・check（要確認）
export function judgeSegment(seg, x) {
  var d = seg.from;
  var none = function (code) { return { status: 'none', code: code }; };
  var check = function (code, recheck) { return { status: 'check', code: code, recheck: !!recheck }; };
  switch (x.method) {
    case 'exempt': return none('exempt');
    case 'simplified': return none('simplified');
    case 'niwari':
      if (d < '2026-10-01') return none('niwari');
      if (x.party === 'individual') return d < '2027-01-01' ? none('niwari') : check('niwari_end_ind', true);
      return d < '2027-10-01' ? check('niwari_corp_fy') : check('niwari_end_corp', true);
    case 'sanwari':
      if (x.party === 'corporation') return check('sanwari_corp', true);
      if (d < '2027-01-01') return check('sanwari_before');
      if (d < '2029-01-01') return none('sanwari');
      return check('sanwari_end', true);
    case 'general':
      if (x.small !== 'no' && d < '2029-10-01') return check(x.small === 'yes' ? 'small_yes' : 'small_unknown');
      return { status: 'diff', code: 'general' };
    default: return check('method_unknown');
  }
}

// 月額の差（1円未満切り捨て）。税込 × 10/110 × pct% を整数のまま計算する
export function diffAmount(monthly, pct) { return monthly ? Math.floor(monthly * pct / 1100) : null; }
// 税込額に対する割合（小数1桁）
export function diffPctOfTotal(pct) { return Math.round(pct / 11 * 10) / 10; }

function ym(iso) { return iso.slice(0, 7); }
function prevMonth(iso) { var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1; if (m === 0) { y--; m = 12; } return y + '-' + String(m).padStart(2, '0'); }

// 時期別の表。今日を含む区切りから、判定が同じ区切りをまとめて返す
export function judge(input) {
  var x = normalizeInput(input);
  var start = 0;
  for (var i = 0; i < SEGMENTS.length; i++) if (SEGMENTS[i].from <= x.today) start = i;
  var rows = [];
  for (var j = start; j < SEGMENTS.length; j++) {
    var seg = SEGMENTS[j], r = judgeSegment(seg, x);
    var row = { from: ym(seg.from), to: null, status: r.status, code: r.code, recheck: !!r.recheck, pct: seg.pct, amount: null, now: j === start };
    if (r.status === 'diff') row.amount = diffAmount(x.monthly, seg.pct);
    if (r.status === 'check') row.hintAmount = diffAmount(x.monthly, seg.pct);
    if (r.status === 'none') row.pct = null;
    var last = rows[rows.length - 1];
    if (last && last.status === row.status && last.code === row.code && last.pct === row.pct) continue;
    if (last) last.to = prevMonth(seg.from + '');
    rows.push(row);
  }
  var questions = [];
  rows.forEach(function (row) { var q = row.status === 'check' && Q_OF[row.code]; if (q && questions.indexOf(q) < 0) questions.push(q); });
  return { input: x, rows: rows, current: rows[0], questions: questions, compare: compareCut(x, rows[0]) };
}

// 言われた値下げと、今の時期の相手側の差を比べる
export function compareCut(x, row) {
  if (!x.cut) return { kind: 'none' };
  var cutPct = null, cutAmount = null;
  if (x.cut.type === 'rate') { cutPct = x.cut.value; if (x.monthly) cutAmount = Math.floor(x.monthly * x.cut.value / 100); }
  else { cutAmount = x.cut.value; if (x.monthly) cutPct = Math.round(cutAmount / x.monthly * 10000) / 100; }
  var out = { cutPct: cutPct, cutAmount: cutAmount, kind: row.status === 'none' ? 'noDiff' : row.status === 'check' ? 'check' : '' };
  if (out.kind) return out;
  if (cutPct == null) { out.kind = 'needMonthly'; return out; }
  out.diffPct = diffPctOfTotal(row.pct);
  out.diffAmount = row.amount;
  var ratio = cutPct / (row.pct / 11);
  out.ratio = Math.round(ratio * 10) / 10;
  out.kind = ratio >= 1.1 ? 'ratio' : ratio <= 0.9 ? 'below' : 'same';
  return out;
}

export function rowLabel(row, lang) {
  var L = T[lang] || T.ja;
  return L.range(L.month(row.from), row.to ? L.month(row.to) : '');
}

// 行の中身（状態・額・説明）を文字にする。showAmount=false なら金額を出さず割合だけにする
export function rowText(row, lang, showAmount) {
  var L = T[lang] || T.ja;
  var note = row.code === 'general' ? L.note.general(row.pct) : L.note[row.code];
  var value = '';
  if (row.status === 'diff') value = showAmount !== false && row.amount != null ? L.yen(row.amount) + L.paren(L.pctOf(diffPctOfTotal(row.pct))) : L.pctOf(diffPctOfTotal(row.pct));
  var hint = row.status === 'check' ? L.hint(showAmount !== false && row.hintAmount != null ? L.yen(row.hintAmount) : null, L.pctOf(diffPctOfTotal(row.pct))) : '';
  return { label: rowLabel(row, lang), status: L.status[row.status], recheck: row.recheck ? L.recheck : '', value: value, note: note, hint: hint,
    short: row.code === 'general' ? L.note.generalShort(row.pct) : note,
    amountText: row.amount != null && showAmount !== false ? L.yen(row.amount) : '', pctText: L.pctOf(diffPctOfTotal(row.pct)) };
}

export function cutText(result, lang) {
  var L = T[lang] || T.ja, c = result.compare;
  if (c.kind === 'none') return L.cut.none;
  if (c.kind === 'needMonthly') return L.cut.needMonthly;
  var cut = c.cutAmount != null ? L.yen(c.cutAmount) + (c.cutPct != null ? L.paren(L.cut.rate(c.cutPct)) : '') : L.cut.rate(c.cutPct);
  if (c.kind === 'noDiff') return L.cut.noDiff(cut);
  if (c.kind === 'check') return L.cut.check(cut);
  var diff = c.diffAmount != null ? L.yen(c.diffAmount) : L.pctOf(c.diffPct);
  if (c.kind === 'ratio') return L.cut.ratio(cut, diff, c.ratio);
  if (c.kind === 'below') return L.cut.below(cut, diff);
  return L.cut.same(cut, diff);
}

// 相手へ送る確認文。要確認の項目だけを尋ねる。要確認が無ければ、見込みを伝える文にする。
// format: 'text'（メールに貼る）・'md'（/md-pdf/ で PDF にする）
export function buildMessage(result, opts) {
  var o = opts || {}, lang = o.lang === 'en' ? 'en' : 'ja', md = o.format === 'md', L = T[lang], M = L.msg, x = result.input;
  var bullet = md || lang === 'en' ? '- ' : '・', out = [];
  out.push(M.to, '', M.hello);
  if (result.questions.length) {
    out.push(M.askLead, '');
    result.questions.forEach(function (q, i) { out.push((i + 1) + '. ' + M.q[q]); });
    out.push('', M.askEnd);
  } else {
    var facts = [L.method[x.method]];
    if (x.method === 'general') facts.push(L.small[x.small]);
    if ((x.method === 'niwari' || x.method === 'sanwari') && x.party) facts.push(L.party[x.party]);
    out.push(M.tellLead(facts.join(lang === 'en' ? ', ' : '・')), '');
    result.rows.forEach(function (row) {
      var t = rowText(row, lang, o.showAmount);
      out.push(bullet + (row.status === 'diff' ? M.rowDiff(t.label, t.value) : M.rowNone(t.label)));
    });
    out.push('', M.tellEnd);
  }
  out.push('', md || lang === 'en' ? '---' : '――', '', (md ? '**' + M.premiseHead + '**' : M.premiseHead), '');
  M.premises.forEach(function (p) { out.push(bullet + p); });
  return out.join('\n') + '\n';
}

// URL のフラグメント（# の後ろ）に入れる条件。サーバーへは送られない
export function encodeState(input) {
  var x = normalizeInput(input), p = ['m=' + x.method, 's=' + x.small];
  if (x.party) p.push('p=' + (x.party === 'individual' ? 'i' : 'c'));
  if (x.monthly) p.push('a=' + x.monthly);
  if (x.cut) p.push('c=' + (x.cut.type === 'rate' ? 'r' : 'y') + x.cut.value);
  return p.join('&');
}

export function decodeState(hash) {
  var out = {};
  String(hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('='); if (i < 0) return;
    var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
    if (k === 'm' && METHODS.indexOf(v) >= 0) out.method = v;
    if (k === 's' && SMALLS.indexOf(v) >= 0) out.small = v;
    if (k === 'p' && (v === 'i' || v === 'c')) out.party = v === 'i' ? 'individual' : 'corporation';
    if (k === 'a' && /^\d{1,10}$/.test(v)) out.monthly = Number(v);
    if (k === 'c' && /^[ry]\d+(\.\d+)?$/.test(v)) out.cut = { type: v[0] === 'r' ? 'rate' : 'amount', value: Number(v.slice(1)) };
  });
  return out;
}
// ===== ここまでコア =====

// ---- MCP の入口 ----
export function invoiceNebikiTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const showAmount = opts.showAmount !== false;
  const cut = opts.cutRate != null ? { type: 'rate', value: opts.cutRate } : opts.cutAmount != null ? { type: 'amount', value: opts.cutAmount } : null;
  if (opts.cutRate != null && opts.cutAmount != null) throw new InvoiceNebikiError('INVALID_CUT', 'pass either cutRate or cutAmount, not both');
  const r = judge({ method: opts.method, party: opts.party, small: opts.small, monthly: opts.monthly, cut, today: opts.today });
  const L = T[lang];
  const cmp = showAmount ? r.compare : { ...r.compare, cutAmount: null, diffAmount: null };
  return {
    ok: true,
    input: { ...r.input, methodLabel: L.method[r.input.method] },
    rows: r.rows.map((row) => {
      const t = rowText(row, lang, showAmount);
      return { from: row.from, to: row.to, status: row.status, statusLabel: t.status, recheck: row.recheck, current: row.now,
        pct: row.pct, pctOfTotal: row.pct == null ? null : diffPctOfTotal(row.pct),
        monthlyDiff: showAmount ? row.amount : null, ifStandardMonthlyDiff: showAmount && row.status === 'check' ? row.hintAmount : null,
        label: t.label, text: row.status === 'diff' ? t.value : row.status === 'check' ? t.hint : '', note: t.note };
    }),
    comparison: { ...cmp, text: cutText({ ...r, compare: cmp }, lang) },
    questions: r.questions.map((q) => ({ id: q, text: L.msg.q[q] })),
    message: buildMessage(r, { lang, format: opts.format === 'md' ? 'md' : 'text', showAmount }),
    premises: L.premises,
    fragment: encodeState({ method: r.input.method, party: r.input.party, small: r.input.small, monthly: r.input.monthly, cut: r.input.cut }),
  };
}
