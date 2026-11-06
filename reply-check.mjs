/* AI の返信案の送る前チェック（reply_check）
 * 照合のコア（normalize / extract / checkReply ほか）は FirstCHTools の site/okurumae/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を切り出し（site側は字下げ2文字を落とす。
 * こちらはコアの中に export を書かず、末尾でまとめて export する）、diff が空になることで同期を確かめる:
 *   diff <(sed -n '/^  \/\/ ===== ここからコア/,/^  \/\/ ===== ここまでコア/p' site/okurumae/app.js | sed 's/^  //') \
 *        <(sed -n '/^\/\/ ===== ここからコア/,/^\/\/ ===== ここまでコア/p' reply-check.mjs | sed 's/^export //')
 *
 * 届いたメール（＋自分で決めた事実）と AI が書いた返信案を照らし合わせ、返信案の日付・曜日・時刻・金額・数量・電話・
 * メール・URL・宛名・番号のうち、原文のどちらにも無いものを赤、あるものを緑、[お客様1]・〇〇・XX などの消し忘れを黄で返す。
 * 本文は書き換えず、照合のときだけ全角/半角などをそろえる。完全ローカル処理・ネットワーク送信なし。 */

// ===== ここからコア（DOM に触らない。document の無いときは globalThis.__okurumae で公開し、tests/okurumae.test.mjs が確かめる。MCP の reply-check.mjs と同じ） =====
var WD_JA = '日月火水木金土';
var WD_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
var KANJI_NUM = '〇一二三四五六七八九';
// 宛名の前に来ても名前ではない語（お客様・皆様・ご担当者様など）
var NOT_NAMES = ['客', '皆', '各位', '会員', '利用者', '担当者', '担当', '担当者各位', '保護者', '関係者', '奥', '旦那', '生徒', '参加者', '出席者', '応募者',
  '購入者', '一同', '子', '家族', '親御', '両親', '主人', '先方', '相手', '神', '王', '仏', '仕', '模', '同', '異', '多', '有', '左', '一', '皆々', 'みな', 'みなさ',
  '店長', '部長', '課長', '社長', '先生', '院長', '会長', '係', '幹事', '代表', '業者', '来店者', 'ゲスト', 'メンバー', 'スタッフ', 'オーナー', '運営', '事務局',
  '予約係', 'ご予約係', '受付', '窓口', '貴社', '御社', '貴店', '利用', '入会者', '新入会員', '児童', '園児', '父兄', 'お父', 'お母', 'じい', 'ばあ', 'お兄', 'お姉',
  '兄', '姉', '弟', '妹', '娘', '息子', '奥方', 'お連れ', '連れ', '患者', '契約者', '依頼者', '世帯主', 'ご本人', '本人', '母', '父', '孫', '嬢', '主',
  '苦労', '世話', '馳走', '愁傷', '気の毒', 'おかげ', 'たく', '注文者', '予約者', '依頼主', '得意', '取引先', '店舗', '施主', '入居者', '宿泊者', '利用者各位'];
var NOT_NAMES_EN = ['customer', 'customers', 'sir', 'madam', 'sir or madam', 'guest', 'guests', 'team', 'all', 'valued', 'friend', 'friends', 'member', 'members', 'client', 'parent', 'parents'];
var TITLE_TAIL = /(?:部長|課長|係長|社長|店長|先生|院長|会長|代表|さん|様)$/;

// 照合用にそろえる（本文は書き換えない）。NFKC で全角英数・記号を半角に、数字の間の長音・ダッシュを「-」に。
// map[i] は、そろえた文字列の i 文字目が元の文字列の何文字目から来たか（最後に元の長さを足す）
function normalize(s) {
  s = String(s == null ? '' : s);
  var out = '', map = [];
  for (var i = 0; i < s.length;) {
    var cp = s.codePointAt(i), ch = String.fromCodePoint(cp), n = ch.normalize('NFKC');
    if (ch === '〜' || ch === '～') n = '~';
    for (var k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
    i += ch.length;
  }
  map.push(s.length);
  out = out.replace(/(\d)(\s*)[ー‐‑‒–—―−](?=\s*\d)/g, '$1$2-');     // 長さを変えない（map がそのまま使える）
  return { t: out, map: map, src: s };
}
function toOrig(N, s, e) {
  var a = N.map[s], j = e;
  while (j < N.t.length && N.map[j] === N.map[e - 1]) j++;
  return [a, j >= N.t.length ? N.src.length : N.map[j]];
}
function kanjiNum(s) {
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  if (s === '十') return 10;
  var m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? KANJI_NUM.indexOf(m[1]) : 1) * 10 + (m[2] ? KANJI_NUM.indexOf(m[2]) : 0);
  if (/^[〇一二三四五六七八九]$/.test(s)) return KANJI_NUM.indexOf(s);
  return NaN;
}
function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
function digits(s) { return String(s).replace(/\D/g, ''); }

// 月日から年を決める（年が書かれていなければ、今日の60日前〜305日後に入る年）
function inferYear(m, d, today) {
  var t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  for (var dy = -1; dy <= 1; dy++) {
    var y = today.getFullYear() + dy, t = Date.UTC(y, m - 1, d), diff = (t - t0) / 864e5;
    if (diff >= -60 && diff <= 305) return y;
  }
  return today.getFullYear();
}
function weekdayOf(y, m, d) {
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return -1;          // 11月31日など存在しない日
  return dt.getUTCDay();
}
function wdIndex(w) {
  if (!w) return -1;
  var i = WD_JA.indexOf(w);
  if (i >= 0 && w.length === 1) return i;
  var k = w.toLowerCase().slice(0, 3);
  return WD_EN.indexOf(k);
}
function monthIndex(w) { return MONTHS_EN.indexOf(w.toLowerCase().slice(0, 3)) + 1; }

// 1つの文章から照合の対象を拾う。種類ごとに順に探し、先に拾った範囲とは重ねない
function extract(text) {
  var N = normalize(text), t = N.t, used = new Uint8Array(t.length + 1), toks = [];
  function free(s, e) { for (var i = s; i < e; i++) if (used[i]) return false; return true; }
  function add(tok, s, e) {
    if (e <= s || !free(s, e)) return null;
    for (var i = s; i < e; i++) used[i] = 1;
    var o = toOrig(N, s, e);
    tok.ns = s; tok.ne = e; tok.start = o[0]; tok.end = o[1]; tok.text = N.src.slice(o[0], o[1]);
    toks.push(tok);
    return tok;
  }
  function each(re, fn) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(t))) {
      var s = m.index, e = s + m[0].length;
      if (!free(s, e)) { re.lastIndex = s + 1; continue; }     // 先に拾った範囲にかかるなら、1字ずらして探し直す
      fn(m, s, e);
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  // URL・メール
  each(/\bhttps?:\/\/[^\s<>"'()\[\]{}「」『』【】、。]+|\bwww\.[A-Za-z0-9-]+\.[^\s<>"'()\[\]{}「」『』【】、。]+/gi, function (m, s, e) {
    var v = m[0].replace(/[.,!?;:]+$/, ''); e = s + v.length;
    // 大小文字をそろえるのはスキームとホストだけ（パス・クエリの /Reserve と /reserve は別のリンク。RFC 3986 6.2.2.1）
    // スキーム・wwwの有無・末尾の「/」は別の接続先になり得るのでそろえない。空のパスだけ「/」と同じに扱う（RFC 3986 6.2.3）
    var sc = (v.match(/^https?:\/\//i) || [''])[0], u = v.slice(sc.length), cut = u.search(/[\/?#]/), host = cut < 0 ? u : u.slice(0, cut), rest = cut < 0 ? '' : u.slice(cut);
    if (rest.charAt(0) !== '/') rest = '/' + rest;
    add({ type: 'url', key: sc.toLowerCase() + host.toLowerCase() + rest }, s, e);
  });
  each(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, function (m, s, e) { add({ type: 'email', key: m[0].toLowerCase() }, s, e); });

  // 消し忘れ（黄）。宛名・数字より先に拾う
  var PH_WORDS = '名前|氏名|名|日付|日時|時間|時刻|金額|料金|会社|店名|住所|電話|番号|担当|お客様|宛名|URL|メール|ここ|入力|記入|挿入|要確認|未定|〇|○|◯|X|x';
  each(new RegExp('\\[[^\\[\\]\\n]{1,30}\\](?!\\()|【\\s*】|【[^【】\\n]{0,20}?(?:' + PH_WORDS + ')[^【】\\n]{0,10}】|\\{\\{?[^{}\\n]{1,30}\\}\\}?|<[^<>\\n]*[^\\x00-\\x7f<>\\n][^<>\\n]*>|_{3,}', 'g'), function (m, s, e) {
    add({ type: 'placeholder', key: m[0] }, s, e);
  });
  each(/(?<![一二三四五六七八九十〇])[〇○◯●△□■◇×]{2,}(?![一二三四五六七八九十〇])|[〇○◯●△□×](?=[月日時分円様名人号年])/g, function (m, s, e) { add({ type: 'placeholder', key: m[0] }, s, e); });
  each(/(?<![A-Za-z0-9])[Xx]{2,}(?:[-:\/][Xx]{2,})*(?![A-Za-z0-9])/g, function (m, s, e) { add({ type: 'placeholder', key: m[0] }, s, e); });

  // 日付（年月日・月/日・年-月-日・英語の月名）。直後（英語は直前も）の曜日を含める
  function attachWeekday(tok, s, e) {
    var rest = t.slice(e, e + 16), m;
    if ((m = /^\s*\(\s*([月火水木金土日])(?:曜日?)?\s*(?:[・,、]\s*祝日?\s*)?\)/.exec(rest)) || (m = /^\s*([月火水木金土日])曜日?/.exec(rest))) {
      tok.wd = wdIndex(m[1]); e += m[0].length;
    } else if ((m = /^\s*\(\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?\s*\)/i.exec(rest))) {
      tok.wd = wdIndex(m[1]); e += m[0].length;
    } else {
      var before = t.slice(Math.max(0, s - 14), s);
      if ((m = /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?,?\s*(?:the\s+)?$/i.exec(before))) { tok.wd = wdIndex(m[1]); s -= m[0].length; }
    }
    return [s, e];
  }
  function addDate(y, mo, d, s, e) {
    mo = mo ? +mo : 0; d = +d;
    if ((mo && (mo < 1 || mo > 12)) || d < 1 || d > 31) return;
    var tok = { type: 'date', y: y ? +y : 0, m: mo, d: d, wd: -1 }, r = attachWeekday(tok, s, e);
    tok.key = (tok.y || '') + '-' + (mo || '*') + '-' + d;
    add(tok, r[0], r[1]);
  }
  each(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, function (m, s, e) { addDate(m[1], m[2], m[3], s, e); });
  each(/(?<![\d\/.:-])(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?![\d\/.-])/g, function (m, s, e) { addDate(m[1], m[2], m[3], s, e); });
  each(/(?<![\d\/.:-])(\d{1,2})\/(\d{1,2})(?![\d\/])/g, function (m, s, e) { addDate(0, m[1], m[2], s, e); });
  each(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi, function (m, s, e) { addDate(m[3], monthIndex(m[1]), m[2], s, e); });
  each(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b(?:,?\s+(\d{4})\b)?/gi, function (m, s, e) { addDate(m[3], monthIndex(m[2]), m[1], s, e); });
  // 日だけ（「8日（日）」「〜10日」）。月は前の日付から引き継ぐ
  each(/(?<![\d月\/.,泊])(\d{1,2})\s*日(?!間|本|後|前|目|分|以|中|ぶり|おき|毎|ごと|当日|程度|ほど|くらい|ぐらい|まで以内)/g, function (m, s, e) { addDate(0, 0, m[1], s, e); });

  // 時刻（18:30・18時30分・18時半・午後6時・6:30 pm・6 pm）。「18:00」「06:00」のようなコロンの形は24時間表記として読み、
  // 午前・午後の無い「〇時」だけを両方に読む（06:00 を 18時 と一致させない）
  function addTime(ap1, h, mi, half, ap2, s, e, colon) {
    h = +h; mi = half ? 30 : (mi ? +mi : 0);
    if (h > 30 || mi > 59) return;
    var ap = (ap1 || ap2 || '').toLowerCase().replace(/\./g, ''), keys = [];
    if (ap === '午後' || ap === 'pm') keys.push((h % 12 + 12) * 60 + mi);
    else if (ap === '午前' || ap === 'am') keys.push((h % 12) * 60 + mi);
    else { keys.push(h * 60 + mi); if (!colon && h >= 1 && h <= 11) keys.push((h + 12) * 60 + mi); if (!colon && h === 12) keys.push(mi); }
    add({ type: 'time', keys: keys, key: keys.join('|') }, s, e);
  }
  var AP = '(午前|午後|AM|PM|am|pm|a\\.m\\.|p\\.m\\.)';
  each(new RegExp('(?:' + AP + '\\s*)?(?<![\\d:.])(\\d{1,2})\\s*(?::(\\d{2})(?!\\d)|時(?!間)(?:\\s*(\\d{1,2})\\s*分(?!間)|(半))?)(?:\\s*' + AP + '(?![A-Za-z]))?', 'g'), function (m, s, e) { addTime(m[1], m[2], m[3] || m[4], m[5], m[6], s, e, m[3] != null); });
  each(new RegExp('(?<![\\d:.])(\\d{1,2})\\s*' + AP + '(?![A-Za-z])', 'g'), function (m, s, e) { addTime('', m[1], 0, '', m[2], s, e); });

  // 電話（数字が10〜11桁。+81 は 0 に読み替える。「+81 (0)90」の (0) は国内の0なので重ねない）
  each(/(?<![\w.\/-])(?:\+81[-\s]?\(?0?\)?|\(?0)\d{1,4}\)?[-\s]?\d{1,4}[-\s]?\d{3,4}(?![\w-])/g, function (m, s, e) {
    var dg = digits(m[0]);
    if (m[0].charAt(0) === '+') dg = dg.slice(2);
    if (dg[0] !== '0') dg = '0' + dg;
    if (dg.length >= 10 && dg.length <= 11) add({ type: 'phone', key: dg }, s, e);
  });

  // 金額（円・万・千・¥・$・yen）
  each(/(?:[¥\\]\s?)?(\d[\d,]*(?:\.\d+)?)(?:\s*(万|千)(?:(\d[\d,]*)(千)?)?)?\s*円/g, function (m, s, e) {
    var v = num(m[1]) * (m[2] === '万' ? 10000 : m[2] === '千' ? 1000 : 1);
    if (m[3]) v += num(m[3]) * (m[4] ? 1000 : 1);
    add({ type: 'money', key: 'JPY:' + Math.round(v) }, s, e);
  });
  each(/[¥\\]\s?(\d[\d,]*(?:\.\d+)?)(?:\s*(万))?/g, function (m, s, e) { add({ type: 'money', key: 'JPY:' + Math.round(num(m[1]) * (m[2] ? 10000 : 1)) }, s, e); });
  each(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:yen|JPY)\b/gi, function (m, s, e) { add({ type: 'money', key: 'JPY:' + Math.round(num(m[1])) }, s, e); });
  each(/(?:US)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|USD)\b/gi, function (m, s, e) { add({ type: 'money', key: 'USD:' + num(m[1] || m[2]) }, s, e); });

  // 数量（2名・3泊・50%・4 adults）。「お一人様」「1人あたり」は単価の言い方なので数えない
  // 桁区切り（1,100）は1つの数として読み、数の途中（「1,100」の「100」）からは読み始めない。
  // 止めるのは直前が数字のときと、「数字,」「数字.」の後ろがちょうど3桁のとき（桁区切りの続き）だけ。「2泊,3名」「2,3人」の後ろの数は読む
  // 直前に大人・子どもの語があれば区分（adult・child）を組にして持つ（「大人2名・子ども1名」と「大人1名・子ども2名」を取り違えない）。
  // 区分は2つだけにし、男性・女性・学生などの言い換えには付けない（数と単位だけで照合する）
  var QTY_LABEL = { '大人': 'adult', 'おとな': 'adult', '成人': 'adult', '子ども': 'child', '子供': 'child', 'こども': 'child', 'お子様': 'child', 'お子さま': 'child', '子様': 'child',
    '小人': 'child', '児童': 'child', '小学生': 'child', '幼児': 'child', '乳児': 'child', '未就学児': 'child', '赤ちゃん': 'child' };
  var QTY_LABEL_RE = new RegExp('(' + Object.keys(QTY_LABEL).sort(function (a, b) { return b.length - a.length; }).join('|') + ')\\s*(?::|は|が)?\\s*$');
  function qtyLabel(s) { var m = QTY_LABEL_RE.exec(t.slice(Math.max(0, s - 10), s)); return m ? QTY_LABEL[m[1]] : ''; }
  var UNIT = { '名': '人', '名様': '人', '人': '人', '人様': '人', 'つ': '個', 'ヶ月': 'か月', 'ケ月': 'か月', 'カ月': 'か月', 'ヵ月': 'か月', 'か月': 'か月', '才': '歳', 'パーセント': '%', '%': '%' };
  var UNIT_EN = { people: '人', persons: '人', person: '人', guests: '人', guest: '人', adults: '人', adult: '人', children: '人', child: '人', kids: '人', pax: '人',
    nights: '泊', night: '泊', pieces: '個', pcs: '個', items: '個', item: '個', tickets: '枚', ticket: '枚', seats: '席', seat: '席', rooms: '室', room: '室',
    hours: '時間', hour: '時間', hrs: '時間', minutes: '分', minute: '分', mins: '分', days: '日間', day: '日間', weeks: '週間', week: '週間', months: 'か月', month: 'か月', percent: '%' };
  each(/(お|ご)?(?<!\d)(?<!\d[,.](?=\d{3}(?!\d)))(\d{1,3}(?:,\d{3})+(?![\d,])|\d+(?:\.\d+)?|[一二三四五六七八九十]{1,3})\s*(名様|人様|名|人|個|つ|枚|本|台|件|部|冊|泊|回|杯|皿|席|組|箱|セット|点|日間|時間|分間|分|秒|週間|か月|カ月|ヶ月|ケ月|ヵ月|年間|年|歳|才|%|パーセント|割|cm|mm|km|kg|ml|mL|m|g|L|坪|畳|階|番|号室|号|室)(?![A-Za-z])(あたり|当たり|につき|ずつ)?/g, function (m, s, e) {
    var isK = !/^\d/.test(m[2]);
    if (isK && !/^(名様?|人様?|泊|組)$/.test(m[3])) return;      // 漢数字は「一杯」「もう一つ」などの言い回しが多いので人数・泊・組だけ
    var v = isK ? kanjiNum(m[2]) : num(m[2]);
    if (isNaN(v)) return;
    if (m[4] || (m[1] && v === 1 && /^(名|人)/.test(m[3]))) return;     // 単価の言い方
    var u = UNIT[m[3]] || m[3];
    add({ type: 'qty', key: v + u, label: qtyLabel(s) }, s + (m[1] ? m[1].length : 0), e - (m[4] ? m[4].length : 0));
  });
  var LABEL_EN = { adults: 'adult', adult: 'adult', children: 'child', child: 'child', kids: 'child' };
  each(/(?<!\d)(?<!\d[,.](?=\d{3}(?!\d)))(\d{1,3}(?:,\d{3})+(?![\d,])|\d+(?:\.\d+)?)\s*(people|persons?|guests?|adults?|children|child|kids|pax|nights?|pieces|pcs|items?|tickets?|seats?|rooms?|hours?|hrs|minutes?|mins|days?|weeks?|months?|percent)\b/gi, function (m, s, e) {
    var w = m[2].toLowerCase();
    add({ type: 'qty', key: num(m[1]) + UNIT_EN[w], label: LABEL_EN[w] || qtyLabel(s) }, s, e);
  });

  // 曜日だけ（「土曜日」「Saturday」「土日」）
  each(/([月火水木金土日])曜日?/g, function (m, s, e) { add({ type: 'weekday', wds: [wdIndex(m[1])], key: m[1] }, s, e); });
  each(/土日(?!曜)/g, function (m, s, e) { add({ type: 'weekday', wds: [6, 0], key: '土日' }, s, e); });
  each(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues?|Wed|Thur?s?|Fri|Sat)s?\b\.?/g, function (m, s, e) { add({ type: 'weekday', wds: [wdIndex(m[1])], key: m[1] }, s, e); });

  // 宛名（〇〇様・さま・さん・殿・御中、Dear / Mr. / Ms.）
  each(/(様|さま|さん|殿|御中)/g, function (m, s, e) {
    if (used[s]) return;
    if (m[1] === '様' && /^[々子式相]/.test(t.slice(e, e + 1))) return;
    var s0 = s;
    while (s0 > 0 && t[s0 - 1] === ' ' && !used[s0 - 1]) s0--;     // 「田中 様」
    var i = s0, sp = 0;
    while (i > 0 && s0 - i < 14) {
      var c = t[i - 1];
      if (used[i - 1]) break;
      if (/[\p{Script=Han}々〆ヵヶ\p{Script=Katakana}ー・A-Za-z]/u.test(c)) { i--; continue; }
      if (c === ' ' && !sp && i < s0 && i > 1 && /[\p{Script=Han}々\p{Script=Katakana}A-Za-z]/u.test(t[i - 2])) { sp = 1; i--; continue; }
      break;
    }
    if (i === s0) {          // ひらがなの名前（行頭・空白・句読点の直後から）
      var j = s0;
      while (j > 0 && s0 - j < 8 && /[ぁ-ゟ]/.test(t[j - 1]) && !used[j - 1]) j--;
      if (j < s0 && (j === 0 || /[\s、。「『(,]/.test(t[j - 1]))) i = j;
    }
    var name = t.slice(i, s0).replace(/^ +/, '');
    i = s0 - name.length;
    var bare = name.replace(/^[おご]/, '').replace(/ /g, '');
    if (!bare || NOT_NAMES.indexOf(bare) >= 0 || NOT_NAMES.indexOf(name.replace(/ /g, '')) >= 0) return;
    if (m[1] === '様' && /[同仕模異多有左]$/.test(bare)) return;      // 同様・仕様・模様など
    if (/^[一二三四五六七八九十]+[人名]$/.test(bare)) return;          // お一人様・二名様
    var nm = name.replace(/ +$/, '').replace(/^[おご](?=.)/, '');
    add({ type: 'name', key: bare.replace(TITLE_TAIL, '') || bare, parts: nm.replace(TITLE_TAIL, '').split(/ +/).filter(Boolean) }, i, e);
  });
  each(/\b(?:Dear\s+(?:(?:Mr|Ms|Mrs|Mx|Dr|Miss)\.?\s+)?|(?:Mr|Ms|Mrs|Mx|Dr)\.?\s+|Miss\s+)([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)/g, function (m, s, e) {
    var nm = m[1];
    if (NOT_NAMES_EN.indexOf(nm.toLowerCase()) >= 0 || NOT_NAMES_EN.indexOf(nm.split(/\s+/)[0].toLowerCase()) >= 0) return;
    add({ type: 'name', key: nm.replace(/\s+/g, ''), parts: nm.split(/\s+/) }, e - nm.length, e);
  });

  // そのほかの番号（3桁以上・123-4567 など）
  each(/(?<![\d,.])\d{1,3}(?:,\d{3})+(?![\d,])|(?<![\d-])\d[\d-]{1,}\d(?![\d-])/g, function (m, s, e) {
    var dg = digits(m[0]);
    if (dg.length >= 3) add({ type: 'number', key: /,/.test(m[0]) ? String(num(m[0])) : dg }, s, e);
  });

  // 日だけの日付に、同じ文章の前の日付の月を入れる
  toks.sort(function (a, b) { return a.start - b.start; });
  var lastM = 0, lastY = 0;
  toks.forEach(function (k) {
    if (k.type !== 'date') return;
    if (k.m) { lastM = k.m; lastY = k.y; } else if (lastM) { k.m = lastM; k.y = k.y || lastY; k.inherited = true; }
  });
  return { tokens: toks, norm: N };
}

var NAME_CH = '\\p{Script=Han}々〆ヵヶ\\p{Script=Katakana}ーA-Za-z\'’';
function nameRe(key) {
  var body = Array.from(key).map(function (c) { return c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }).join(' ?');
  return new RegExp('(?<![' + NAME_CH + '])' + body + '(?![' + NAME_CH + '])', 'gu');
}
function dateMatch(a, b) {
  if (a.d !== b.d) return false;
  if (a.m && b.m && a.m !== b.m) return false;
  if (a.y && b.y && a.y !== b.y) return false;
  return true;
}
function matches(r, s) {
  if (r.type === 'date') return s.type === 'date' && dateMatch(r, s);
  if (r.type === 'time') return s.type === 'time' && r.keys.some(function (k) { return s.keys.indexOf(k) >= 0; });
  if (r.type === 'weekday') return (s.type === 'weekday' && r.wds.every(function (w) { return s.wds.indexOf(w) >= 0; })) || (s.type === 'date' && r.wds.length === 1 && s.wd === r.wds[0]);
  if (r.type === 'phone' || r.type === 'number') return (s.type === 'phone' || s.type === 'number') && s.key === r.key;
  // 宛名は敬称・空白を除いた名前が一致すること。姓だけ・名だけは、相手が空白で区切って書いた部分と一致するときだけ（「林」と「小林」は別人）
  // 逆向き（原文が「田中様」・返信案が「田中 次郎様」）は緑にしない。原文に無い「次郎」を足しているため
  // 数量は数と単位が同じこと。両方に区分（adult・child）があり、それが食い違うときだけ一致にしない
  if (r.type === 'qty') return s.type === 'qty' && s.key === r.key && (!r.label || !s.label || r.label === s.label);
  if (r.type === 'name') return s.type === 'name' && (s.key === r.key || (s.parts || []).indexOf(r.key) >= 0);
  return s.type === r.type && s.key === r.key;
}

// 照らし合わせる。received・facts のどちらかに同じものがあれば緑、無ければ赤、消し忘れは黄
function checkReply(received, reply, facts, opts) {
  opts = opts || {};
  var today = opts.today instanceof Date ? opts.today : new Date();
  var R = extract(reply), S = [{ id: 'received', x: extract(received) }, { id: 'facts', x: extract(facts || '') }];
  var items = [], MAX_HITS = 20, nameHits = {};
  R.tokens.forEach(function (tok) {
    var it = { type: tok.type, text: tok.text, start: tok.start, end: tok.end, status: 'green', reasons: [], hits: [] };
    if (tok.type === 'placeholder') { it.status = 'yellow'; it.reasons.push('placeholder'); items.push(it); return; }
    // 一致の記録は1件あたり MAX_HITS 箇所まで（同じ語が大量にある文章でメモリを使い切らない）
    for (var si = 0; si < S.length && it.hits.length < MAX_HITS; si++) {
      var sts = S[si].x.tokens;
      for (var ti = 0; ti < sts.length && it.hits.length < MAX_HITS; ti++) {
        var st = sts[ti];
        if (matches(tok, st)) it.hits.push({ src: S[si].id, start: st.start, end: st.end, y: st.y || 0, m: st.m || 0 });
      }
    }
    // 署名・名乗り（「森川 結衣」「井上です」）は原文の中を探す。前後が名前の文字に続いていないこと（「小林」の中の「林」は数えない）
    // 同じ名前は1回だけ探す
    if (tok.type === 'name' && !it.hits.length) {
      if (!Object.prototype.hasOwnProperty.call(nameHits, tok.key)) {
        var found = [];
        S.forEach(function (src) {
          var N = src.x.norm, re = nameRe(tok.key), m;
          while (found.length < MAX_HITS && (m = re.exec(N.t))) { var o = toOrig(N, m.index, m.index + m[0].length); found.push({ src: src.id, start: o[0], end: o[1] }); }
        });
        nameHits[tok.key] = found;
      }
      it.hits = nameHits[tok.key].slice();
    }
    if (!it.hits.length) { it.status = 'red'; it.reasons.push('missing'); }
    if (tok.type === 'date' && tok.wd >= 0) {
      var m = tok.m, y = tok.y;
      if (!m) { var h0 = it.hits.filter(function (h) { return h.m; })[0]; if (h0) { m = h0.m; y = y || h0.y; } }
      if (!y) { var hy = it.hits.filter(function (h) { return h.y; })[0]; if (hy) y = hy.y; }
      if (m) {
        y = y || inferYear(m, tok.d, today);
        var real = weekdayOf(y, m, tok.d);
        it.date = { y: y, m: m, d: tok.d, written: tok.wd, actual: real };
        if (real !== tok.wd) { it.status = 'red'; it.reasons.push(real < 0 ? 'nodate' : 'weekday'); }
      }
    } else if (tok.type === 'date' && tok.m) {
      var yy = tok.y || inferYear(tok.m, tok.d, today);
      if (weekdayOf(yy, tok.m, tok.d) < 0) { it.status = 'red'; it.reasons.push('nodate'); it.date = { y: yy, m: tok.m, d: tok.d, written: -1, actual: -1 }; }
    }
    items.push(it);
  });
  var count = { red: 0, yellow: 0, green: 0 };
  items.forEach(function (it) { count[it.status]++; });
  return { items: items, count: count };
}

// 見本（架空のメール）。日付は今日から数えて作る（年が変わっても曜日が合う）
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function nextWeekday(today, wd, minAhead) { var d = addDays(today, minAhead); while (d.getDay() !== wd) d = addDays(d, 1); return d; }
function md(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
function wj(d) { return WD_JA[d.getDay()]; }
function mdEn(d) { return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()] + ' ' + d.getDate(); }
function samples(today) {
  var sat = nextWeekday(today, 6, 8), sun = addDays(sat, 1), thu = nextWeekday(today, 4, 8), fri = addDays(thu, 1), sun2 = nextWeekday(today, 0, 10);
  return {
    main: {
      received: '見本亭 ご予約係様\n\nはじめまして。森川と申します。\n' + md(sat) + '（' + wj(sat) + '）の18時30分から、大人4名で夕食の予約をお願いできますか。\nコースはお一人5,500円のものを希望します。\n当日の連絡先は 090-0000-1234 です。\n\n森川 結衣',
      facts: '営業時間 17:00〜23:00（月曜定休）\nコース 5,500円／7,700円\n電話 03-0000-5678',
      reply: '森田様\n\nこのたびは見本亭へご予約のご連絡をいただき、ありがとうございます。\n' + md(sun) + '（' + wj(sat) + '）18:30より、大人4名様でご予約を承りました。\nコースはお一人様6,600円のものをご用意いたします。\n当日は17時より営業しております。お気をつけてお越しください。\nご不明な点は 03-0000-5678 までお電話ください。\n\n見本亭',
      expectRed: ['森田様', md(sun) + '（' + wj(sat) + '）', '6,600円']
    },
    weekday: {
      received: 'こんにちは。PTA広報係の佐々木です。\n次回の打ち合わせは ' + md(fri) + '（' + wj(fri) + '）の10時からでいかがでしょうか。\n場所は図書室を予定しています。',
      facts: '',
      reply: '佐々木様\n\nご連絡ありがとうございます。\n' + md(fri) + '（' + wj(thu) + '）の10時から、図書室で承知しました。\n当日はよろしくお願いいたします。',
      expectRed: [md(fri) + '（' + wj(thu) + '）']
    },
    price: {
      received: 'はじめまして、山本と申します。\n来月の子ども向けクッキー教室に、親子2人で参加したいのですが、料金はおいくらでしょうか。',
      facts: '参加費 1人1,500円（材料費込み）\n時間 10:00〜12:00\n定員 8組',
      reply: '山本様\n\nお問い合わせありがとうございます。\n参加費はお一人1,500円です。親子2人でのご参加をお待ちしております。\n別途、材料費として500円をいただきます。\n時間は10:00〜12:00、定員は8組です。\nキャンセルは前日まで無料、当日は50%を頂戴します。',
      expectRed: ['500円', '50%']
    },
    name: {
      received: '町内会の中村です。\n' + md(sun2) + '（' + wj(sun2) + '）の清掃活動ですが、雨の場合は延期でしょうか。',
      facts: '',
      reply: '中川様\n\nお問い合わせありがとうございます。\n' + md(sun2) + '（' + wj(sun2) + '）の清掃活動は、雨天の場合は翌週に延期します。\n決まり次第、回覧板でお知らせします。',
      expectRed: ['中川様']
    },
    placeholder: {
      received: 'お世話になっております。見本工務店の小林です。\n先日お送りした見積書について、ご確認いただけましたでしょうか。',
      facts: '',
      reply: '[お客様名]様\n\nいつもお世話になっております。〇〇でございます。\nお見積書を拝見しました。XX日までにお返事いたします。\n\n【担当者名】',
      expectRed: [], expectYellow: ['[お客様名]', '〇〇', 'XX', '【担当者名】']
    },
    phone: {
      received: 'はじめまして。ネイルの予約をしたい井上です。\n折り返しのお電話は ０８０－００００－２４６８ にお願いします。',
      facts: '',
      reply: '井上様\n\nご連絡ありがとうございます。\n080-0000-2468 に本日中にお電話いたします。',
      expectRed: []
    },
    ok: {
      received: '見本ヨガ教室様\n' + md(thu) + '（' + wj(thu) + '）19時のクラスに、友人と2名で参加できますか。\nメールは yoga-taro@example.com です。\n田村',
      facts: '料金 1回2,000円\nヨガマットの貸出 300円\nhttps://example.com/yoga',
      reply: '田村様\n\nお問い合わせありがとうございます。\n' + md(thu) + '（' + wj(thu) + '）19:00のクラス、2名様で承りました。\n料金はお一人1回2,000円です。ヨガマットの貸出は300円です。\n詳しくは https://example.com/yoga をご覧ください。\n確認のメールを yoga-taro@example.com にお送りします。',
      expectRed: []
    },
    en: {
      received: 'Hi, this is Yui Morikawa.\nCould I book a table for 4 adults on ' + WD_EN_FULL[sat.getDay()] + ', ' + mdEn(sat) + ' at 6:30 pm?\nI would like the $55 course. My number is 090-0000-1234.',
      facts: 'Open 5:00 pm – 11:00 pm, closed on Mondays\nCourses: $55 / $77\nPhone: 03-0000-5678',
      reply: 'Dear Ms. Morita,\n\nThank you for your reservation request.\nWe have booked a table for 4 adults on ' + WD_EN_FULL[sat.getDay()] + ', ' + mdEn(sun) + ' at 6:30 pm.\nWe will prepare the $66 course for you.\nWe open at 5 pm. If you have any questions, please call 03-0000-5678.\n\nMihon-tei',
      expectRed: ['Morita', WD_EN_FULL[sat.getDay()] + ', ' + mdEn(sun), '$66']
    }
  };
}
var WD_EN_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// ===== ここまでコア =====

// ---- MCP の入口 ----
export { normalize, extract, checkReply, inferYear, weekdayOf, samples };

export class ReplyCheckError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 1欄あたりの上限（文字数）。拾い出しの正規表現と照合の総当たりは長さの2乗で重くなるため、メール1通に十分な長さで止める
export const REPLY_CHECK_MAX_CHARS = 20000;
// 返す項目と、1項目あたりの一致箇所の上限（件数 count は上限で切る前の全件）。応答が数MBにならないようにする
export const REPLY_CHECK_MAX_ITEMS = 500;
export const REPLY_CHECK_MAX_HITS = 5;

const RC_MSG = {
  ja: {
    missing: '届いたメールにも事実欄にも無い',
    weekday: (d) => d.y + '年' + d.m + '月' + d.d + '日は' + WD_JA[d.actual] + '曜日（' + WD_JA[d.written] + 'ではない）',
    nodate: (d) => d.m + '月' + d.d + '日は存在しない日付',
    placeholder: '記号・仮の文字が残っている',
    note: '赤が0件でも内容の正しさは保証しません。拾うのは日付・曜日・時刻・金額・数量・電話・メール・URL・宛名・番号だけで、文の意味や言い回しは見ていません。',
  },
  en: {
    missing: 'Not in the email or your facts',
    weekday: (d) => d.m + '/' + d.d + '/' + d.y + ' is a ' + WD_EN_FULL[d.actual] + ', not ' + WD_EN_FULL[d.written],
    nodate: (d) => d.m + '/' + d.d + ' does not exist',
    placeholder: 'Placeholder left in the reply',
    note: 'A score of 0 red does not mean the reply is correct. Only dates, weekdays, times, amounts, quantities, phone numbers, emails, URLs, names and numbers are checked — not meaning or tone.',
  },
};

function rcText(v, name) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new ReplyCheckError('INVALID_INPUT', name + ' must be a string');
  if (v.length > REPLY_CHECK_MAX_CHARS) throw new ReplyCheckError('TOO_LONG', name + ' is longer than ' + REPLY_CHECK_MAX_CHARS + ' characters');
  return v;
}

function rcToday(s) {
  if (s == null || s === '') return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  if (!dt || dt.getFullYear() !== +m[1] || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) {
    throw new ReplyCheckError('INVALID_TODAY', 'today must be a real date in YYYY-MM-DD');
  }
  return dt;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function replyCheckTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const L = RC_MSG[lang];
  const reply = rcText(opts.reply, 'reply');
  if (!reply.trim()) throw new ReplyCheckError('REPLY_REQUIRED', 'reply (the AI-drafted reply to check) is required');
  const received = rcText(opts.received, 'received');
  const facts = rcText(opts.facts, 'facts');
  const today = rcToday(opts.today);
  const includeGreen = opts.includeGreen !== false;
  const sources = { received, facts };

  const r = checkReply(received, reply, facts, { today });
  const lineStarts = [0];
  for (let i = 0; i < reply.length; i++) if (reply[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
  };

  const picked = r.items.filter((it) => includeGreen || it.status !== 'green');
  const items = picked.slice(0, REPLY_CHECK_MAX_ITEMS).map((it) => {
    const out = { status: it.status, type: it.type, text: it.text, start: it.start, end: it.end, ...lineOf(it.start), reasons: it.reasons.slice() };
    const msgs = it.reasons.map((k) => (k === 'weekday' || k === 'nodate' ? L[k](it.date) : L[k])).filter(Boolean);
    if (msgs.length) out.message = msgs.join(' / ');
    if (it.date) {
      out.date = { date: it.date.y + '-' + pad2(it.date.m) + '-' + pad2(it.date.d) };
      if (it.date.written >= 0) out.date.writtenWeekday = WD_EN_FULL[it.date.written];
      if (it.date.actual >= 0) out.date.actualWeekday = WD_EN_FULL[it.date.actual];
    }
    out.hitCount = it.hits.length;
    out.hits = it.hits.slice(0, REPLY_CHECK_MAX_HITS).map((h) => ({ source: h.src, start: h.start, end: h.end, text: sources[h.src].slice(h.start, h.end) }));
    return out;
  });

  return {
    count: { ...r.count },
    items,
    truncated: picked.length > items.length,
    note: L.note,
    today: today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate()),
  };
}
