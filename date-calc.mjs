/* 日数・営業日計算（date_calc）
 * 計算コア（dcToDays / dcCountRange / dcAddBusinessDays / dcRun ほか）は
 * FirstCHTools の site/date-calc/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 日付は Date を使わず「1970-01-01 からの通算日」の整数で扱うので、
 * サーバーのタイムゾーン設定に結果が左右されない。
 * 祝日は date-holidays.json（内閣府「国民の祝日について」由来）を読む。
 * 完全ローカル処理・ネットワーク送信なし。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ==================== ここから計算コア（site / MCP で同一） ==================== */

export class DateCalcError extends Error {
  constructor(code, info) {
    super(code);
    this.name = 'DateCalcError';
    this.code = code;
    this.info = info || {};
  }
}

/** 週の休みのプリセット（0=日曜 … 6=土曜） */
export const DC_WEEKEND = {
  'sat-sun': [0, 6],
  sun: [0],
  'fri-sat': [5, 6],
  none: [],
};

/** 扱える年の範囲。暦（グレゴリオ暦の先行適用）が意味を持つ範囲に限る */
export const DC_MIN_YEAR = 1583;
export const DC_MAX_YEAR = 9999;
/** 1回の計算で走査する日数の上限（暴走を止めるための安全弁） */
export const DC_MAX_SPAN = 200000;
/** 営業日を探して進める日数の上限（全部が休みの設定だと見つからないため） */
export const DC_MAX_SEEK = 20000;

export function dcIsLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export const DC_MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function dcDaysInMonth(y, m) {
  return m === 2 && dcIsLeap(y) ? 29 : DC_MDAYS[m - 1];
}

/** 年月日 → 1970-01-01 からの通算日（Howard Hinnant の days_from_civil）。Date を経由しない */
export function dcToDays(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // 0..399
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // 0..365
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // 0..146096
  return era * 146097 + doe - 719468;
}

/** 通算日 → 年月日（civil_from_days） */
export function dcFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097; // 0..146096
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153); // 0..11（3月始まり）
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** 曜日（0=日曜 … 6=土曜）。1970-01-01 は木曜 */
export function dcWeekday(z) {
  return ((z % 7) + 11) % 7;
}

export function dcPad(n, w) {
  let s = String(Math.abs(n));
  while (s.length < w) s = '0' + s;
  return (n < 0 ? '-' : '') + s;
}

export function dcIso(y, m, d) {
  return dcPad(y, 4) + '-' + dcPad(m, 2) + '-' + dcPad(d, 2);
}

export function dcIsoFromDays(z) {
  const c = dcFromDays(z);
  return dcIso(c.y, c.m, c.d);
}

/**
 * 文字列 → { y, m, d, days }。
 * `2026-09-20` `2026/9/20` `2026.9.20` `20260920` `2026年9月20日` を受け取る。
 */
export function dcParseDate(input, field) {
  const s = String(input == null ? '' : input).trim();
  if (s === '') throw new DateCalcError('EMPTY_DATE', { field });
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new DateCalcError('BAD_DATE', { field, text: s });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < DC_MIN_YEAR || y > DC_MAX_YEAR) throw new DateCalcError('YEAR_RANGE', { field, text: s, year: y, min: DC_MIN_YEAR, max: DC_MAX_YEAR });
  if (mo < 1 || mo > 12) throw new DateCalcError('BAD_DATE', { field, text: s });
  if (d < 1 || d > dcDaysInMonth(y, mo)) throw new DateCalcError('NO_SUCH_DATE', { field, text: s, last: dcDaysInMonth(y, mo) });
  return { y, m: mo, d, days: dcToDays(y, mo, d) };
}

/** 日付の並び（改行・カンマ・空白区切り）を読む。読めた日付と、読めなかった行を返す */
export function dcParseDateList(text) {
  const dates = [];
  const errors = [];
  const seen = Object.create(null);
  String(text == null ? '' : text)
    .split(/[\s,、;；]+/)
    .forEach((raw) => {
      const s = raw.trim();
      if (s === '' || s.charAt(0) === '#') return;
      try {
        const p = dcParseDate(s);
        const iso = dcIso(p.y, p.m, p.d);
        if (!seen[iso]) {
          seen[iso] = true;
          dates.push(iso);
        }
      } catch (e) {
        if (!(e instanceof DateCalcError)) throw e;
        errors.push({ text: s, code: e.code });
      }
    });
  dates.sort();
  return { dates, errors };
}

/** 入力の指定 → 判定に使う設定。holidays には holidays.json をそのまま渡す */
export function dcOptions(o) {
  const src = o || {};
  const weekendKey = Object.prototype.hasOwnProperty.call(DC_WEEKEND, src.weekend) ? src.weekend : 'sat-sun';
  const table = src.holidays && typeof src.holidays === 'object' ? src.holidays : null;
  const useHolidays = src.useHolidays === undefined ? true : !!src.useHolidays;
  const closed = dcParseDateList(src.closedDates);
  const work = dcParseDateList(src.workDates);
  const closedSet = Object.create(null);
  closed.dates.forEach((d) => { closedSet[d] = true; });
  const workSet = Object.create(null);
  work.dates.forEach((d) => { workSet[d] = true; });
  return {
    weekendKey,
    weekend: DC_WEEKEND[weekendKey],
    useHolidays: useHolidays && !!(table && table.days),
    hasTable: !!(table && table.days),
    yearEnd: !!src.yearEnd,
    table: table,
    closed: closedSet,
    work: workSet,
    closedList: closed.dates,
    workList: work.dates,
    badDates: closed.errors.concat(work.errors),
  };
}

/** 年末年始（12/29〜1/3）か */
export function dcIsYearEnd(c) {
  return (c.m === 12 && c.d >= 29) || (c.m === 1 && c.d <= 3);
}

/**
 * その日が何の日か。
 * type は work / weekend / holiday / year-end / closed のいずれか（優先度はこの逆順）。
 */
export function dcDayInfo(z, opt) {
  const c = dcFromDays(z);
  const date = dcIso(c.y, c.m, c.d);
  const wd = dcWeekday(z);
  const holidayName = opt.useHolidays && opt.table.days[date] ? opt.table.days[date] : null;
  const flags = {
    weekend: opt.weekend.indexOf(wd) >= 0,
    holiday: !!holidayName,
    yearEnd: opt.yearEnd && dcIsYearEnd(c),
    closed: !!opt.closed[date],
    forcedWork: !!opt.work[date],
  };
  let type = 'work';
  if (flags.weekend) type = 'weekend';
  if (flags.yearEnd) type = 'year-end';
  if (flags.holiday) type = 'holiday';
  if (flags.closed) type = 'closed';
  if (flags.forcedWork) type = 'work';
  const business = type === 'work';
  return { days: z, date, y: c.y, m: c.m, d: c.d, weekday: wd, type, business, holiday: holidayName, flags };
}

export function dcIsBusiness(z, opt) {
  return dcDayInfo(z, opt).business;
}

/** 祝日データの範囲外の年を含むか */
export function dcOutOfTable(fromZ, toZ, opt) {
  if (!opt.useHolidays) return null;
  const a = dcFromDays(fromZ).y;
  const b = dcFromDays(toZ).y;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo >= opt.table.minYear && hi <= opt.table.maxYear) return null;
  return { from: lo, to: hi, min: opt.table.minYear, max: opt.table.maxYear };
}

/** fromZ 〜 toZ（両端を含む）を1日ずつ数える */
export function dcCountRange(fromZ, toZ, opt) {
  if (toZ < fromZ) return dcCountRange(toZ, fromZ, opt);
  const span = toZ - fromZ + 1;
  if (span > DC_MAX_SPAN) throw new DateCalcError('RANGE_TOO_LONG', { days: span, max: DC_MAX_SPAN });
  const r = {
    calendar: span,
    business: 0,
    nonBusiness: 0,
    weekend: 0,
    holiday: 0,
    holidayOnWorkday: 0,
    yearEnd: 0,
    closed: 0,
    forcedWork: 0,
    weekdays: [0, 0, 0, 0, 0, 0, 0],
    holidayList: [],
  };
  for (let z = fromZ; z <= toZ; z++) {
    const info = dcDayInfo(z, opt);
    r.weekdays[info.weekday]++;
    if (info.business) r.business++;
    else r.nonBusiness++;
    if (info.flags.weekend) r.weekend++;
    if (info.flags.holiday) {
      r.holiday++;
      if (!info.flags.weekend) r.holidayOnWorkday++;
      if (r.holidayList.length < 400) r.holidayList.push({ date: info.date, name: info.holiday, weekday: info.weekday, business: info.business });
    }
    if (info.flags.yearEnd) r.yearEnd++;
    if (info.flags.closed) r.closed++;
    if (info.flags.forcedWork) r.forcedWork++;
  }
  return r;
}

/** 年・月・日に分けた差（1/31 → 3/1 は「1ヶ月1日」のように月末を丸めて数える） */
export function dcDiffParts(fromZ, toZ) {
  if (toZ < fromZ) {
    const r = dcDiffParts(toZ, fromZ);
    r.negative = true;
    return r;
  }
  const a = dcFromDays(fromZ);
  const b = dcFromDays(toZ);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  let anchor = dcAddMonths(fromZ, months);
  if (anchor > toZ) {
    months--;
    anchor = dcAddMonths(fromZ, months);
  }
  return { years: Math.floor(months / 12), months: months % 12, days: toZ - anchor, totalMonths: months, negative: false };
}

/** nヶ月後（月末は丸める。1/31 の1ヶ月後は 2/28 または 2/29） */
export function dcAddMonths(z, n) {
  const c = dcFromDays(z);
  const total = c.y * 12 + (c.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  const d = Math.min(c.d, dcDaysInMonth(y, m));
  return dcToDays(y, m, d);
}

/** 休みなら前後の営業日へ寄せる。mode: next / prev / none */
export function dcAdjust(z, opt, mode) {
  if (mode !== 'next' && mode !== 'prev') return { days: z, moved: 0 };
  const step = mode === 'next' ? 1 : -1;
  let cur = z;
  let moved = 0;
  while (!dcIsBusiness(cur, opt)) {
    cur += step;
    moved++;
    if (moved > DC_MAX_SEEK) throw new DateCalcError('NO_BUSINESS_DAY', { max: DC_MAX_SEEK });
  }
  return { days: cur, moved: moved * step };
}

/**
 * 起点日から n 営業日。
 * includeStart が true なら起点日（それが営業日なら）を1営業日目として数える。
 * n が負なら過去へ数える。飛ばした休みの一覧も返す。
 */
export function dcAddBusinessDays(z, n, opt, includeStart) {
  const skipped = [];
  let count = 0;
  let cur = z;
  let steps = 0;
  const step = n < 0 ? -1 : 1;
  const target = Math.abs(n);
  if (target === 0) return { days: z, skipped, count: 0 };
  if (includeStart && dcIsBusiness(z, opt)) count = 1;
  else if (includeStart) {
    // 起点日が休みのときは、数え始めの営業日まで進めてからそれを1日目とする
    while (!dcIsBusiness(cur, opt)) {
      const info = dcDayInfo(cur, opt);
      if (skipped.length < 200) skipped.push({ date: info.date, type: info.type, name: info.holiday, weekday: info.weekday });
      cur += step;
      if (++steps > DC_MAX_SEEK) throw new DateCalcError('NO_BUSINESS_DAY', { max: DC_MAX_SEEK });
    }
    count = 1;
  }
  while (count < target) {
    cur += step;
    if (++steps > DC_MAX_SEEK) throw new DateCalcError('NO_BUSINESS_DAY', { max: DC_MAX_SEEK });
    const info = dcDayInfo(cur, opt);
    if (info.business) count++;
    else if (skipped.length < 200) skipped.push({ date: info.date, type: info.type, name: info.holiday, weekday: info.weekday });
  }
  return { days: cur, skipped, count: count };
}

/** 起点日以降（同日を含む）で最初に来る締め日。day は 1〜31 か 'eom'（月末） */
export function dcClosingDate(z, day) {
  const c = dcFromDays(z);
  if (day === 'eom') {
    const last = dcToDays(c.y, c.m, dcDaysInMonth(c.y, c.m));
    return last >= z ? last : dcAddMonths(last, 1);
  }
  const n = Number(day);
  if (!(n >= 1 && n <= 31)) throw new DateCalcError('BAD_CLOSING', { day: day });
  // その月に無い日（2月31日など）は月末として扱う
  const inMonth = dcToDays(c.y, c.m, Math.min(n, dcDaysInMonth(c.y, c.m)));
  if (inMonth >= z) return inMonth;
  const next = dcAddMonths(dcToDays(c.y, c.m, 1), 1);
  const nc = dcFromDays(next);
  return dcToDays(nc.y, nc.m, Math.min(n, dcDaysInMonth(nc.y, nc.m)));
}

/** 締め日の n ヶ月後の、指定した日（'eom' は月末） */
export function dcPayDate(closingZ, monthOffset, day) {
  const base = dcAddMonths(dcToDays(dcFromDays(closingZ).y, dcFromDays(closingZ).m, 1), monthOffset);
  const c = dcFromDays(base);
  if (day === 'eom') return dcToDays(c.y, c.m, dcDaysInMonth(c.y, c.m));
  const n = Number(day);
  if (!(n >= 1 && n <= 31)) throw new DateCalcError('BAD_PAYDAY', { day: day });
  return dcToDays(c.y, c.m, Math.min(n, dcDaysInMonth(c.y, c.m)));
}

export function dcDayOut(z, opt) {
  const info = dcDayInfo(z, opt);
  return { date: info.date, weekday: info.weekday, type: info.type, business: info.business, holiday: info.holiday };
}

/**
 * 計算の入口。site と MCP が同じ結果オブジェクトを使う。
 * mode: between（2日付の間） / add（起点日＋N） / payment（締め日と支払サイト）
 */
export function dcRun(input) {
  const src = input || {};
  const opt = dcOptions(src);
  const mode = src.mode === 'add' || src.mode === 'payment' ? src.mode : 'between';
  const warnings = [];
  if (opt.badDates.length) warnings.push({ code: 'BAD_EXTRA_DATE', info: { list: opt.badDates.map((e) => e.text) } });
  if (src.useHolidays !== false && !opt.hasTable) warnings.push({ code: 'NO_HOLIDAY_TABLE', info: {} });

  const settings = {
    weekend: opt.weekendKey,
    holidays: opt.useHolidays,
    year_end: opt.yearEnd,
    closed_dates: opt.closedList,
    work_dates: opt.workList,
  };

  if (mode === 'between') {
    const a = dcParseDate(src.start, 'start');
    const b = dcParseDate(src.end, 'end');
    const swapped = b.days < a.days;
    const fromZ = swapped ? b.days : a.days;
    const toZ = swapped ? a.days : b.days;
    if (swapped) warnings.push({ code: 'SWAPPED', info: {} });
    const outside = dcOutOfTable(fromZ, toZ, opt);
    if (outside) warnings.push({ code: 'OUT_OF_TABLE', info: outside });
    const includeStart = src.includeStart === undefined ? true : !!src.includeStart;
    const countFrom = includeStart ? fromZ : Math.min(fromZ + 1, toZ + 1);
    const counts = countFrom > toZ
      ? { calendar: 0, business: 0, nonBusiness: 0, weekend: 0, holiday: 0, holidayOnWorkday: 0, yearEnd: 0, closed: 0, forcedWork: 0, weekdays: [0, 0, 0, 0, 0, 0, 0], holidayList: [] }
      : dcCountRange(countFrom, toZ, opt);
    const parts = dcDiffParts(fromZ, toZ);
    const diff = toZ - fromZ;
    return {
      mode: 'between',
      settings: settings,
      start: dcDayOut(fromZ, opt),
      end: dcDayOut(toZ, opt),
      include_start: includeStart,
      calendar_days: counts.calendar,
      days_between: diff,
      days_inclusive: diff + 1,
      business_days: counts.business,
      non_business_days: counts.nonBusiness,
      weekend_days: counts.weekend,
      holiday_days: counts.holiday,
      holidays_on_weekdays: counts.holidayOnWorkday,
      year_end_days: counts.yearEnd,
      extra_closed_days: counts.closed,
      extra_work_days: counts.forcedWork,
      weeks: { weeks: Math.floor(diff / 7), days: diff % 7 },
      breakdown: { years: parts.years, months: parts.months, days: parts.days, total_months: parts.totalMonths },
      weekday_counts: counts.weekdays,
      holiday_list: counts.holidayList,
      warnings: warnings,
    };
  }

  if (mode === 'add') {
    const base = dcParseDate(src.base !== undefined ? src.base : src.start, 'base');
    const unit = ['days', 'business', 'weeks', 'months', 'years'].indexOf(src.unit) >= 0 ? src.unit : 'business';
    if (String(src.n === undefined ? '' : src.n).trim() === '') throw new DateCalcError('BAD_NUMBER', { text: '' });
    const n = Math.trunc(Number(src.n));
    if (!isFinite(n)) throw new DateCalcError('BAD_NUMBER', { text: String(src.n) });
    if (Math.abs(n) > 100000) throw new DateCalcError('NUMBER_RANGE', { max: 100000 });
    const includeStart = !!src.includeStart;
    const adjustMode = ['next', 'prev', 'none'].indexOf(src.adjust) >= 0 ? src.adjust : 'none';
    let rawZ;
    let skipped = [];
    if (unit === 'business') {
      const r = dcAddBusinessDays(base.days, n, opt, includeStart);
      rawZ = r.days;
      skipped = r.skipped;
    } else if (unit === 'days') {
      rawZ = base.days + (includeStart && n !== 0 ? (n > 0 ? n - 1 : n + 1) : n);
    } else if (unit === 'weeks') {
      rawZ = base.days + n * 7;
    } else if (unit === 'months') {
      rawZ = dcAddMonths(base.days, n);
    } else {
      rawZ = dcAddMonths(base.days, n * 12);
    }
    const outside = dcOutOfTable(Math.min(base.days, rawZ), Math.max(base.days, rawZ), opt);
    if (outside) warnings.push({ code: 'OUT_OF_TABLE', info: outside });
    const adj = unit === 'business' ? { days: rawZ, moved: 0 } : dcAdjust(rawZ, opt, adjustMode);
    const resultZ = adj.days;
    const lo = Math.min(base.days, resultZ);
    const hi = Math.max(base.days, resultZ);
    const counts = dcCountRange(lo, hi, opt);
    return {
      mode: 'add',
      settings: settings,
      base: dcDayOut(base.days, opt),
      amount: n,
      unit: unit,
      include_start: includeStart,
      adjust: unit === 'business' ? 'none' : adjustMode,
      result: dcDayOut(resultZ, opt),
      raw_result: adj.moved === 0 ? null : dcDayOut(rawZ, opt),
      moved_days: adj.moved,
      calendar_days: resultZ - base.days,
      business_days_between: counts.business,
      non_business_days_between: counts.nonBusiness,
      skipped_days: skipped,
      warnings: warnings,
    };
  }

  // mode === 'payment'
  const inv = dcParseDate(src.invoice !== undefined ? src.invoice : src.base, 'invoice');
  const closingDay = src.closing === undefined || src.closing === '' ? 'eom' : src.closing;
  const payDay = src.payDay === undefined || src.payDay === '' ? 'eom' : src.payDay;
  const monthOffset = Math.trunc(Number(src.payMonths === undefined ? 1 : src.payMonths));
  if (!isFinite(monthOffset) || monthOffset < 0 || monthOffset > 12) throw new DateCalcError('BAD_PAY_MONTHS', { max: 12 });
  const payAdjust = ['next', 'prev', 'none'].indexOf(src.payAdjust) >= 0 ? src.payAdjust : 'prev';
  const closingZ = closingDay === 'none' ? inv.days : dcClosingDate(inv.days, closingDay);
  const rawPayZ = dcPayDate(closingZ, monthOffset, payDay);
  const outside = dcOutOfTable(inv.days, rawPayZ, opt);
  if (outside) warnings.push({ code: 'OUT_OF_TABLE', info: outside });
  const adj = dcAdjust(rawPayZ, opt, payAdjust);
  if (adj.days < closingZ) warnings.push({ code: 'PAY_BEFORE_CLOSING', info: {} });
  const counts = dcCountRange(Math.min(inv.days, adj.days), Math.max(inv.days, adj.days), opt);
  return {
    mode: 'payment',
    settings: settings,
    invoice: dcDayOut(inv.days, opt),
    closing_rule: { day: closingDay, month_offset: monthOffset, pay_day: payDay, adjust: payAdjust },
    closing: dcDayOut(closingZ, opt),
    payment: dcDayOut(adj.days, opt),
    raw_payment: adj.moved === 0 ? null : dcDayOut(rawPayZ, opt),
    moved_days: adj.moved,
    days_from_invoice: adj.days - inv.days,
    days_from_closing: adj.days - closingZ,
    business_days_from_closing: adj.days > closingZ ? dcCountRange(closingZ + 1, adj.days, opt).business : 0,
    calendar_days_total: counts.calendar,
    warnings: warnings,
  };
}

/* ==================== ここまで計算コア ==================== */

/* ---- ここから下はMCP側だけの層（入出力・文言）。site側の app.js には UI 用の同じ文言表がある ---- */

export class DateCalcToolError extends Error {}

/** 内閣府「国民の祝日について」由来の祝日表（site/date-calc/holidays.json と同じ内容） */
export const HOLIDAYS = JSON.parse(readFileSync(fileURLToPath(new URL('./date-holidays.json', import.meta.url)), 'utf8'));

const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TYPE_JA = {
  work: '営業日',
  weekend: '週の休み',
  holiday: '祝日',
  'year-end': '年末年始',
  closed: '休業日（指定）',
};

const TYPE_EN = {
  work: 'Business day',
  weekend: 'Weekend',
  holiday: 'Public holiday',
  'year-end': 'Year-end break',
  closed: 'Closed (added)',
};

const ERR_JA = {
  EMPTY_DATE: (i) => `日付を入れてください（${i.field || 'date'}）。`,
  BAD_DATE: (i) => `日付として読めません: ${i.text} — 2026-09-20 のように書きます。`,
  NO_SUCH_DATE: (i) => `その日は存在しません: ${i.text}（この月は ${i.last} 日までです）。`,
  YEAR_RANGE: (i) => `扱えるのは ${i.min}年〜${i.max}年です: ${i.text}`,
  BAD_NUMBER: () => 'n には数字を入れてください。',
  NUMBER_RANGE: (i) => `n は ${i.max} までにしてください。`,
  RANGE_TOO_LONG: (i) => `期間が長すぎます（${i.days}日）。${i.max}日までで指定してください。`,
  NO_BUSINESS_DAY: () => '営業日が1日も見つかりません。休みの決め方（weekend・holidays・closed_dates）を見直してください。',
  BAD_CLOSING: (i) => `closing は 1〜31 か eom か none です: ${i.day}`,
  BAD_PAYDAY: (i) => `pay_day は 1〜31 か eom です: ${i.day}`,
  BAD_PAY_MONTHS: (i) => `pay_months は 0〜${i.max} の整数です。`,
};

const ERR_EN = {
  EMPTY_DATE: (i) => `A date is required (${i.field || 'date'}).`,
  BAD_DATE: (i) => `Not a valid date: ${i.text} — write it as 2026-09-20.`,
  NO_SUCH_DATE: (i) => `That day does not exist: ${i.text} (the month ends on the ${i.last}).`,
  YEAR_RANGE: (i) => `Only years ${i.min}–${i.max} are supported: ${i.text}`,
  BAD_NUMBER: () => 'n must be a number.',
  NUMBER_RANGE: (i) => `Keep n at or below ${i.max}.`,
  RANGE_TOO_LONG: (i) => `That range is too long (${i.days} days). Keep it within ${i.max} days.`,
  NO_BUSINESS_DAY: () => 'No business day could be found. Check weekend / holidays / closed_dates.',
  BAD_CLOSING: (i) => `closing must be 1-31, eom or none: ${i.day}`,
  BAD_PAYDAY: (i) => `pay_day must be 1-31 or eom: ${i.day}`,
  BAD_PAY_MONTHS: (i) => `pay_months must be an integer between 0 and ${i.max}.`,
};

const WARN_JA = {
  SWAPPED: () => '開始日と終了日が逆だったので入れ替えて計算しました。',
  OUT_OF_TABLE: (i) => `祝日データは ${i.min}年〜${i.max}年ぶんです。${i.from}年〜${i.to}年のうち範囲の外は、祝日を考えずに数えています。`,
  NO_HOLIDAY_TABLE: () => '祝日データを読み込めなかったため、土日と指定した休業日だけで数えています。',
  BAD_EXTRA_DATE: (i) => `読み取れなかった日付があります: ${i.list.join(' / ')}`,
  PAY_BEFORE_CLOSING: () => '支払日が締め日より前になっています。pay_months・pay_day の指定を見直してください。',
};

const WARN_EN = {
  SWAPPED: () => 'The start and end dates were the wrong way round, so they were swapped.',
  OUT_OF_TABLE: (i) => `The holiday table covers ${i.min}-${i.max}. Years outside that range (${i.from}-${i.to}) are counted without public holidays.`,
  NO_HOLIDAY_TABLE: () => 'The holiday table could not be loaded, so only weekends and the days you listed are treated as days off.',
  BAD_EXTRA_DATE: (i) => `Some dates could not be read: ${i.list.join(' / ')}`,
  PAY_BEFORE_CLOSING: () => 'The payment date falls before the closing date. Check pay_months and pay_day.',
};

const errText = (lang, code, info) => {
  const table = lang === 'en' ? ERR_EN : ERR_JA;
  return table[code] ? table[code](info || {}) : code;
};

const warnText = (lang, w) => {
  const table = lang === 'en' ? WARN_EN : WARN_JA;
  return { code: w.code, message: table[w.code] ? table[w.code](w.info || {}) : w.code };
};

/** 祝日名。英語では holidays.json の names 表で英名へ置き換える */
const holidayLabel = (lang, name) => (!name ? null : lang === 'en' ? HOLIDAYS.names[name] || name : name);

/** 日付1件に曜日・種別の表示名を足す */
function shapeDay(day, lang) {
  if (!day) return null;
  return {
    date: day.date,
    weekday: (lang === 'en' ? WD_EN : WD_JA)[day.weekday],
    weekday_index: day.weekday,
    type: day.type,
    type_label: (lang === 'en' ? TYPE_EN : TYPE_JA)[day.type] || day.type,
    business: day.business,
    holiday: holidayLabel(lang, day.holiday),
  };
}

/** 引数の日付リスト（配列でも改行区切りの文字列でも受ける） */
const asDateText = (v) => (Array.isArray(v) ? v.join('\n') : v === undefined || v === null ? '' : String(v));

/**
 * MCPツール date_calc の本体。2日付間の日数/営業日数・起点日＋Nの期日・支払サイトの3つを受ける。
 * 計算そのものは計算コア（site版と同一）に任せ、ここは入出力と文言だけを持つ。
 */
export async function dateCalcTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new DateCalcToolError(`lang は ja か en: ${o.lang}`);

  const hasStart = typeof o.start === 'string' && o.start.trim() !== '';
  const hasEnd = typeof o.end === 'string' && o.end.trim() !== '';
  const hasBase = typeof o.base === 'string' && o.base.trim() !== '';
  const hasInvoice = typeof o.invoice === 'string' && o.invoice.trim() !== '';
  let mode = o.mode;
  if (mode === undefined) {
    if (hasInvoice) mode = 'payment';
    else if (o.n !== undefined) mode = 'add';
    else mode = 'between';
  }
  if (mode !== 'between' && mode !== 'add' && mode !== 'payment') {
    throw new DateCalcToolError(`mode は between / add / payment のどれかです: ${o.mode}`);
  }
  if (mode === 'between' && !(hasStart && hasEnd)) throw new DateCalcToolError('mode=between には start と end が要ります');
  if (mode === 'add' && !(hasBase || hasStart)) throw new DateCalcToolError('mode=add には base（起点日）が要ります');
  if (mode === 'add' && o.n === undefined) throw new DateCalcToolError('mode=add には n（加える量）が要ります');
  if (mode === 'payment' && !(hasInvoice || hasBase)) throw new DateCalcToolError('mode=payment には invoice（請求・発生日）が要ります');
  if (o.weekend !== undefined && !Object.prototype.hasOwnProperty.call(DC_WEEKEND, o.weekend)) {
    throw new DateCalcToolError(`weekend は ${Object.keys(DC_WEEKEND).join(' / ')} のどれかです: ${o.weekend}`);
  }
  if (o.unit !== undefined && ['days', 'business', 'weeks', 'months', 'years'].indexOf(o.unit) < 0) {
    throw new DateCalcToolError(`unit は days / business / weeks / months / years のどれかです: ${o.unit}`);
  }

  const input = {
    mode: mode,
    start: o.start,
    end: o.end,
    base: hasBase ? o.base : o.start,
    n: o.n,
    unit: o.unit,
    includeStart: mode === 'between' ? (o.include_start === undefined ? true : !!o.include_start) : !!o.include_start,
    adjust: o.adjust,
    invoice: hasInvoice ? o.invoice : o.base,
    closing: o.closing,
    payMonths: o.pay_months,
    payDay: o.pay_day,
    payAdjust: o.pay_adjust,
    weekend: o.weekend,
    useHolidays: o.holidays === undefined ? true : !!o.holidays,
    yearEnd: !!o.year_end,
    closedDates: asDateText(o.closed_dates),
    workDates: asDateText(o.work_dates),
    holidays: HOLIDAYS,
  };

  let r;
  try {
    r = dcRun(input);
  } catch (err) {
    if (!(err instanceof DateCalcError)) throw err;
    // 入力の日付が壊れているのは「呼び出し方の誤り」ではないので、例外ではなく結果として返す
    return { ok: false, mode: mode, error: { code: err.code, message: errText(lang, err.code, err.info) } };
  }

  const out = { ok: true, mode: r.mode, settings: r.settings };
  const warn = r.warnings.map((w) => warnText(lang, w));

  if (r.mode === 'between') {
    Object.assign(out, {
      start: shapeDay(r.start, lang),
      end: shapeDay(r.end, lang),
      include_start: r.include_start,
      calendar_days: r.calendar_days,
      days_between: r.days_between,
      days_inclusive: r.days_inclusive,
      business_days: r.business_days,
      non_business_days: r.non_business_days,
      weekend_days: r.weekend_days,
      holiday_days: r.holiday_days,
      holidays_on_weekdays: r.holidays_on_weekdays,
      year_end_days: r.year_end_days,
      extra_closed_days: r.extra_closed_days,
      extra_work_days: r.extra_work_days,
      weeks: r.weeks,
      breakdown: r.breakdown,
      weekday_counts: r.weekday_counts,
      holidays: r.holiday_list.map((h) => ({
        date: h.date,
        name: holidayLabel(lang, h.name),
        weekday: (lang === 'en' ? WD_EN : WD_JA)[h.weekday],
      })),
    });
  } else if (r.mode === 'add') {
    Object.assign(out, {
      base: shapeDay(r.base, lang),
      amount: r.amount,
      unit: r.unit,
      include_start: r.include_start,
      adjust: r.adjust,
      result: shapeDay(r.result, lang),
      before_adjust: shapeDay(r.raw_result, lang),
      moved_days: r.moved_days,
      calendar_days: r.calendar_days,
      business_days_between: r.business_days_between,
      non_business_days_between: r.non_business_days_between,
      skipped_days: r.skipped_days.map((d) => ({
        date: d.date,
        weekday: (lang === 'en' ? WD_EN : WD_JA)[d.weekday],
        type: d.type,
        type_label: (lang === 'en' ? TYPE_EN : TYPE_JA)[d.type] || d.type,
        name: holidayLabel(lang, d.name),
      })),
    });
  } else {
    Object.assign(out, {
      invoice: shapeDay(r.invoice, lang),
      rule: r.closing_rule,
      closing: shapeDay(r.closing, lang),
      payment: shapeDay(r.payment, lang),
      before_adjust: shapeDay(r.raw_payment, lang),
      moved_days: r.moved_days,
      days_from_invoice: r.days_from_invoice,
      days_from_closing: r.days_from_closing,
      business_days_from_closing: r.business_days_from_closing,
    });
  }

  out.holiday_table = { source: HOLIDAYS.source, min_year: HOLIDAYS.minYear, max_year: HOLIDAYS.maxYear, retrieved: HOLIDAYS.retrieved };
  if (warn.length) out.notes = warn;
  return out;
}
