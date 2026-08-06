// テストデータ生成（ダミーレコード + 文字種・境界値テキスト）
// アルゴリズムは site/testdata/app.js（FirstCHTools リポジトリ）と同一。
// site側が正本で、こちらは追従する（2箇所ルール: 片方を直したらもう片方も同じ内容で直す）。
// 下の「生成ロジック」ブロックは site 側の該当ブロックをそのまま移植したもので、
// 差分を取りやすいよう整形も変えていない（Shift_JIS 逆引き表は Node の TextDecoder でも同じ結果になる）。
// 同期確認（site側リポジトリを隣に置いて実行する。インデント2つ分だけを落として比較する）:
//   diff <(sed -n '/ここから生成ロジック/,/ここまで生成ロジック/p' ../FirstCHTools/site/testdata/app.js | sed 's/^  //') \
//        <(sed -n '/ここから生成ロジック/,/MCPツールの入口/p' testdata.mjs)

/* ==================== ここから生成ロジック（MCP testdata.mjs と同一） ==================== */

/* ---- 乱数（seedで再現可能。FNV-1a → mulberry32） ---- */
function hashSeed(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const int = (rnd, min, max) => min + Math.floor(rnd() * (max - min + 1));
const pad = (n, w) => String(n).padStart(w, '0');

/* ---- データ辞書（実在の姓名・地名を組み合わせた架空データ。実在の個人・法人とは無関係） ---- */
const JA = {
  // [漢字, カタカナ, ローマ字]
  surnames: [
    ['佐藤', 'サトウ', 'sato'], ['鈴木', 'スズキ', 'suzuki'], ['高橋', 'タカハシ', 'takahashi'], ['田中', 'タナカ', 'tanaka'],
    ['伊藤', 'イトウ', 'ito'], ['渡辺', 'ワタナベ', 'watanabe'], ['山本', 'ヤマモト', 'yamamoto'], ['中村', 'ナカムラ', 'nakamura'],
    ['小林', 'コバヤシ', 'kobayashi'], ['加藤', 'カトウ', 'kato'], ['吉田', 'ヨシダ', 'yoshida'], ['山田', 'ヤマダ', 'yamada'],
    ['佐々木', 'ササキ', 'sasaki'], ['山口', 'ヤマグチ', 'yamaguchi'], ['松本', 'マツモト', 'matsumoto'], ['井上', 'イノウエ', 'inoue'],
    ['木村', 'キムラ', 'kimura'], ['林', 'ハヤシ', 'hayashi'], ['清水', 'シミズ', 'shimizu'], ['山崎', 'ヤマザキ', 'yamazaki'],
    ['阿部', 'アベ', 'abe'], ['森', 'モリ', 'mori'], ['池田', 'イケダ', 'ikeda'], ['橋本', 'ハシモト', 'hashimoto'],
    ['石川', 'イシカワ', 'ishikawa'], ['前田', 'マエダ', 'maeda'], ['藤田', 'フジタ', 'fujita'], ['後藤', 'ゴトウ', 'goto'],
    ['岡田', 'オカダ', 'okada'], ['長谷川', 'ハセガワ', 'hasegawa'], ['村上', 'ムラカミ', 'murakami'], ['近藤', 'コンドウ', 'kondo'],
    ['石井', 'イシイ', 'ishii'], ['坂本', 'サカモト', 'sakamoto'], ['遠藤', 'エンドウ', 'endo'], ['青木', 'アオキ', 'aoki'],
    ['藤井', 'フジイ', 'fujii'], ['西村', 'ニシムラ', 'nishimura'], ['福田', 'フクダ', 'fukuda'], ['太田', 'オオタ', 'ota'],
  ],
  givenM: [
    ['太郎', 'タロウ', 'taro'], ['一郎', 'イチロウ', 'ichiro'], ['健太', 'ケンタ', 'kenta'], ['大輔', 'ダイスケ', 'daisuke'],
    ['翔太', 'ショウタ', 'shota'], ['拓也', 'タクヤ', 'takuya'], ['直樹', 'ナオキ', 'naoki'], ['雄一', 'ユウイチ', 'yuichi'],
    ['和也', 'カズヤ', 'kazuya'], ['亮', 'リョウ', 'ryo'], ['誠', 'マコト', 'makoto'], ['隆之', 'タカユキ', 'takayuki'],
    ['修平', 'シュウヘイ', 'shuhei'], ['智也', 'トモヤ', 'tomoya'], ['浩二', 'コウジ', 'koji'], ['優斗', 'ユウト', 'yuto'],
    ['陸', 'リク', 'riku'], ['颯太', 'ソウタ', 'sota'], ['蓮', 'レン', 'ren'], ['悠真', 'ユウマ', 'yuma'],
  ],
  givenF: [
    ['花子', 'ハナコ', 'hanako'], ['美咲', 'ミサキ', 'misaki'], ['さくら', 'サクラ', 'sakura'], ['愛', 'アイ', 'ai'],
    ['陽子', 'ヨウコ', 'yoko'], ['真由美', 'マユミ', 'mayumi'], ['恵', 'メグミ', 'megumi'], ['彩', 'アヤ', 'aya'],
    ['優花', 'ユウカ', 'yuka'], ['七海', 'ナナミ', 'nanami'], ['結衣', 'ユイ', 'yui'], ['杏', 'アン', 'an'],
    ['美穂', 'ミホ', 'miho'], ['千尋', 'チヒロ', 'chihiro'], ['直美', 'ナオミ', 'naomi'], ['愛子', 'アイコ', 'aiko'],
    ['莉子', 'リコ', 'riko'], ['葵', 'アオイ', 'aoi'], ['凛', 'リン', 'rin'], ['芽衣', 'メイ', 'mei'],
  ],
  // 実在の郵便番号・地名（丁目以下は乱数）。市外局番は電話番号の生成にも使う
  places: [
    { zip: '150-0041', pref: '東京都', city: '渋谷区', town: '神南', area: '03' },
    { zip: '100-0005', pref: '東京都', city: '千代田区', town: '丸の内', area: '03' },
    { zip: '160-0022', pref: '東京都', city: '新宿区', town: '新宿', area: '03' },
    { zip: '220-0012', pref: '神奈川県', city: '横浜市西区', town: 'みなとみらい', area: '045' },
    { zip: '231-0023', pref: '神奈川県', city: '横浜市中区', town: '山下町', area: '045' },
    { zip: '330-0854', pref: '埼玉県', city: 'さいたま市大宮区', town: '桜木町', area: '048' },
    { zip: '260-0013', pref: '千葉県', city: '千葉市中央区', town: '中央', area: '043' },
    { zip: '460-0008', pref: '愛知県', city: '名古屋市中区', town: '栄', area: '052' },
    { zip: '450-0002', pref: '愛知県', city: '名古屋市中村区', town: '名駅', area: '052' },
    { zip: '530-0001', pref: '大阪府', city: '大阪市北区', town: '梅田', area: '06' },
    { zip: '542-0085', pref: '大阪府', city: '大阪市中央区', town: '心斎橋筋', area: '06' },
    { zip: '650-0001', pref: '兵庫県', city: '神戸市中央区', town: '加納町', area: '078' },
    { zip: '604-8005', pref: '京都府', city: '京都市中京区', town: '中之町', area: '075' },
    { zip: '730-0011', pref: '広島県', city: '広島市中区', town: '基町', area: '082' },
    { zip: '810-0001', pref: '福岡県', city: '福岡市中央区', town: '天神', area: '092' },
    { zip: '060-0002', pref: '北海道', city: '札幌市中央区', town: '北二条西', area: '011' },
    { zip: '980-0021', pref: '宮城県', city: '仙台市青葉区', town: '中央', area: '022' },
    { zip: '900-0006', pref: '沖縄県', city: '那覇市', town: 'おもろまち', area: '098' },
    { zip: '380-0824', pref: '長野県', city: '長野市', town: '南長野', area: '026' },
    { zip: '320-0033', pref: '栃木県', city: '宇都宮市', town: '本町', area: '028' },
  ],
  companyA: ['山手', '青葉', '大和', '北斗', '明和', '日進', '相互', '中央', '若葉', '瑞穂'],
  companyB: ['商事', '製作所', '工業', 'システムズ', 'デザイン', '物産', '企画', '電機', '建設', '運輸'],
  departments: ['営業部', '総務部', '経理部', '人事部', '開発部', '品質保証部', 'マーケティング部', 'カスタマーサポート部', '法務部', '広報部'],
  // CSVのクォート処理を検証できるよう、カンマ・引用符・改行を含む文を意図的に混ぜている
  texts: [
    'お問い合わせありがとうございます。内容を確認のうえ折り返しご連絡いたします。',
    '資料請求をお願いします。送付先は登録済みの住所で問題ありません。',
    '見積書の "合計金額" について確認したい点があります。',
    '希望日は 5/1, 5/2, 5/8 のいずれかでお願いします。',
    '対応時間帯は平日10:00〜18:00で問題ありません。',
    '添付ファイルが開けませんでした。再送をお願いします。',
    'テスト投稿です。改行を含みます。\n2行目のテキストです。',
    '担当者名の表記ゆれ（山田／ヤマダ）を統一してください。',
    '特に希望はありません。',
  ],
};

const ENG = {
  surnames: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
    'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'],
  givenM: ['James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Daniel', 'Matthew',
    'Anthony', 'Mark', 'Steven', 'Andrew', 'Kevin'],
  givenF: ['Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen',
    'Emily', 'Ashley', 'Emma', 'Olivia', 'Sophia'],
  streets: ['Oak St', 'Maple Ave', 'Cedar Ln', 'Pine Rd', 'Elm St', 'Washington Ave', 'Lake Dr', 'Hill Rd', 'Park Ave', 'Sunset Blvd'],
  // 市外局番は実在、加入者番号は 555-0100〜555-0199（架空番号として予約された範囲）を使う
  places: [
    { city: 'Springfield', state: 'IL', zip: '62704', area: '217' },
    { city: 'Austin', state: 'TX', zip: '78701', area: '512' },
    { city: 'Portland', state: 'OR', zip: '97205', area: '503' },
    { city: 'Denver', state: 'CO', zip: '80202', area: '303' },
    { city: 'Boston', state: 'MA', zip: '02108', area: '617' },
    { city: 'Seattle', state: 'WA', zip: '98101', area: '206' },
    { city: 'Atlanta', state: 'GA', zip: '30303', area: '404' },
    { city: 'Phoenix', state: 'AZ', zip: '85004', area: '602' },
    { city: 'Madison', state: 'WI', zip: '53703', area: '608' },
    { city: 'Buffalo', state: 'NY', zip: '14202', area: '716' },
  ],
  companyA: ['Acme', 'Northwind', 'Contoso', 'Globex', 'Initech', 'Vertex', 'Lumen', 'Cobalt', 'Summit', 'Harbor'],
  companyB: ['Systems', 'Logistics', 'Media', 'Industries', 'Partners', 'Solutions', 'Labs', 'Works', 'Group', 'Design'],
  companyC: ['LLC', 'Inc.', 'Co.', 'Ltd.'],
  departments: ['Sales', 'Accounting', 'Human Resources', 'Engineering', 'Marketing', 'Customer Support', 'Legal', 'Operations', 'Product', 'Finance'],
  texts: [
    'Thank you for your message. We will get back to you shortly.',
    'Please send the brochure, the address on file is fine.',
    'I have a question about the "total amount" on the quote.',
    'Weekday afternoons work best for a call.',
    'The attachment would not open. Could you resend it?',
    'This is a test entry.\nIt contains a line break.',
    'Please keep the spelling of the contact name consistent.',
    'No particular requests.',
  ],
};

const FIELDS = ['id', 'name', 'name_kana', 'name_romaji', 'gender', 'birthday', 'email', 'tel', 'zip', 'address', 'company', 'department', 'url', 'text'];
const JA_ONLY_FIELDS = ['name_kana', 'name_romaji'];
const DEFAULT_FIELDS = ['id', 'name', 'name_kana', 'email', 'tel', 'zip', 'address'];
const EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org']; // RFC 2606 の予約ドメイン（実在しない＝誤送信しない）
const URL_PATHS = ['users', 'items', 'posts', 'orders', 'articles'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (y, m) => (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : DAYS_IN_MONTH[m - 1]);

function buildRecordJa(rnd, i) {
  const sur = pick(rnd, JA.surnames);
  const male = rnd() < 0.5;
  const given = pick(rnd, male ? JA.givenM : JA.givenF);
  const place = pick(rnd, JA.places);
  const y = int(rnd, 1960, 2005);
  const m = int(rnd, 1, 12);
  const d = int(rnd, 1, daysInMonth(y, m));
  const mobile = rnd() < 0.6;
  const tel = mobile
    ? `0${pick(rnd, [70, 80, 90])}-${pad(int(rnd, 0, 9999), 4)}-${pad(int(rnd, 0, 9999), 4)}`
    : place.area.length === 2
      ? `${place.area}-${pad(int(rnd, 1000, 9999), 4)}-${pad(int(rnd, 0, 9999), 4)}`
      : `${place.area}-${pad(int(rnd, 100, 999), 3)}-${pad(int(rnd, 0, 9999), 4)}`;
  return {
    id: String(i + 1),
    name: `${sur[0]} ${given[0]}`,
    name_kana: `${sur[1]} ${given[1]}`,
    name_romaji: `${given[2].charAt(0).toUpperCase()}${given[2].slice(1)} ${sur[2].charAt(0).toUpperCase()}${sur[2].slice(1)}`,
    gender: male ? '男性' : '女性',
    birthday: `${y}-${pad(m, 2)}-${pad(d, 2)}`,
    email: `${given[2]}.${sur[2]}${int(rnd, 1, 99)}@${pick(rnd, EMAIL_DOMAINS)}`,
    tel,
    zip: place.zip,
    address: `${place.pref}${place.city}${place.town}${int(rnd, 1, 9)}-${int(rnd, 1, 30)}-${int(rnd, 1, 30)}`,
    company: `株式会社${pick(rnd, JA.companyA)}${pick(rnd, JA.companyB)}`,
    department: pick(rnd, JA.departments),
    url: `https://example.com/${pick(rnd, URL_PATHS)}/${int(rnd, 1, 9999)}`,
    text: pick(rnd, JA.texts),
  };
}

function buildRecordEn(rnd, i) {
  const sur = pick(rnd, ENG.surnames);
  const male = rnd() < 0.5;
  const given = pick(rnd, male ? ENG.givenM : ENG.givenF);
  const place = pick(rnd, ENG.places);
  const y = int(rnd, 1960, 2005);
  const m = int(rnd, 1, 12);
  const d = int(rnd, 1, daysInMonth(y, m));
  return {
    id: String(i + 1),
    name: `${given} ${sur}`,
    name_kana: '',
    name_romaji: '',
    gender: male ? 'Male' : 'Female',
    birthday: `${y}-${pad(m, 2)}-${pad(d, 2)}`,
    email: `${given.toLowerCase()}.${sur.toLowerCase()}${int(rnd, 1, 99)}@${pick(rnd, EMAIL_DOMAINS)}`,
    tel: `(${place.area}) 555-01${pad(int(rnd, 0, 99), 2)}`,
    zip: place.zip,
    address: `${int(rnd, 1, 9999)} ${pick(rnd, ENG.streets)}, ${place.city}, ${place.state} ${place.zip}`,
    company: `${pick(rnd, ENG.companyA)} ${pick(rnd, ENG.companyB)} ${pick(rnd, ENG.companyC)}`,
    department: pick(rnd, ENG.departments),
    url: `https://example.com/${pick(rnd, URL_PATHS)}/${int(rnd, 1, 9999)}`,
    text: pick(rnd, ENG.texts),
  };
}

/** レコードを生成する。seed が同じなら常に同じ結果を返す */
function generateRecords(opts) {
  const rows = Math.min(Math.max(parseInt(opts.rows, 10) || 1, 1), 1000);
  const locale = opts.locale === 'en' ? 'en' : 'ja';
  const seed = String(opts.seed == null || opts.seed === '' ? Math.floor(Math.random() * 4294967296) : opts.seed);
  const rnd = mulberry32(hashSeed(seed));
  const build = locale === 'en' ? buildRecordEn : buildRecordJa;
  const out = [];
  for (let i = 0; i < rows; i++) out.push(build(rnd, i));
  return { rows, locale, seed, records: out };
}

/* ---- 直列化 ---- */
const NEWLINE = { LF: '\n', CRLF: '\r\n' };

function cell(v, delimiter, nl) {
  // 値の中の改行も出力の改行コードに揃える（CRLFのCSVにLFが残ると読み手によっては行がずれる）
  const s = String(v == null ? '' : v).replace(/\r\n|\r|\n/g, nl);
  // RFC 4180: 区切り文字・引用符・改行を含む値はダブルクォートで囲み、引用符は2重にする
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serialize(records, fields, opts) {
  const nl = NEWLINE[opts.newline] || '\n';
  const cols = fields.filter((f) => FIELDS.includes(f));
  if (opts.format === 'json') {
    const objs = records.map((r) => {
      const o = {};
      for (const f of cols) o[f] = r[f];
      return o;
    });
    return JSON.stringify(objs, null, 2).replace(/\n/g, nl) + nl;
  }
  const delimiter = opts.format === 'tsv' ? '\t' : ',';
  const lines = [];
  if (opts.header) lines.push(cols.join(delimiter));
  for (const r of records) lines.push(cols.map((f) => cell(r[f], delimiter, nl)).join(delimiter));
  return lines.join(nl) + nl;
}

/* ---- .xlsx 書き出し（OOXML SpreadsheetML）----
 * .xlsx の実体は XML を集めた ZIP なので、無圧縮(store)のZIPライターを自前で持てば
 * 外部ライブラリ（SheetJS等）を読み込まずにブラウザ内・Node内のどちらでも書き出せる。
 * タイムスタンプは固定値にしてあるため、同じ seed からは常に同じバイト列になる。 */

/** XMLのテキストノードに置ける形にする。XML 1.0 に存在できない制御文字は落とす
 *  （該当文字が1つでも残るとExcelはファイルを「破損」と判定して開かない） */
function xmlText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, bytes }] を無圧縮(store)のZIPにまとめる */
function zipStore(entries) {
  const files = entries.map((e) => ({
    name: new TextEncoder().encode(e.name),
    bytes: e.bytes,
    crc: crc32(e.bytes),
  }));
  // ローカルヘッダ30 + 中央ディレクトリ46 + ファイル名2回 + 本体、最後にEOCD22
  let total = 22;
  for (const f of files) total += 30 + 46 + f.name.length * 2 + f.bytes.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let p = 0;
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const raw = (b) => { buf.set(b, p); p += b.length; };
  const DOS_DATE = 0x0021; // 1980-01-01（固定＝同じ入力からは常に同じファイルになる）

  const offsets = [];
  for (const f of files) {
    offsets.push(p);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(DOS_DATE);
    u32(f.crc); u32(f.bytes.length); u32(f.bytes.length);
    u16(f.name.length); u16(0);
    raw(f.name); raw(f.bytes);
  }
  const dirStart = p;
  files.forEach((f, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(DOS_DATE);
    u32(f.crc); u32(f.bytes.length); u32(f.bytes.length);
    u16(f.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]);
    raw(f.name);
  });
  const dirSize = p - dirStart; // EOCDを書く前に確定させる（書きながら p が進むため）
  u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length);
  u32(dirSize); u32(dirStart); u16(0);
  return buf;
}

/** 0 → A, 25 → Z, 26 → AA */
function colName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

// 列幅（文字数目安）。既定の幅のままだと住所・自由記述が潰れて中身を確認できない
const XLSX_WIDTHS = {
  id: 6, name: 15, name_kana: 17, name_romaji: 19, gender: 8, birthday: 13, email: 30,
  tel: 17, zip: 11, address: 44, company: 26, department: 18, url: 34, text: 48,
};

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * レコードを .xlsx のバイト列にする。
 * 連番(id)だけ数値セルにし、それ以外は文字列セルにする。郵便番号を数値にすると
 * Excelが先頭の0を落として 02108 → 2108 になるため、文字列で固定する。
 */
function buildXlsx(records, fields, opts = {}) {
  const cols = fields.filter((f) => FIELDS.includes(f));
  const header = opts.header !== false;
  const rows = [];
  let n = 0;

  if (header) {
    n += 1;
    rows.push(`<row r="${n}">${cols
      .map((f, i) => `<c r="${colName(i)}${n}" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlText(f)}</t></is></c>`)
      .join('')}</row>`);
  }
  for (const rec of records) {
    n += 1;
    const cells = cols.map((f, i) => {
      const v = rec[f];
      if (v === '' || v == null) return ''; // 空セルは書かない（疎な行はSpreadsheetMLとして正しい）
      const ref = `${colName(i)}${n}`;
      if (f === 'id') return `<c r="${ref}"><v>${xmlText(v)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
    });
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  }

  const widths = cols
    .map((f, i) => `<col min="${i + 1}" max="${i + 1}" width="${XLSX_WIDTHS[f] || 14}" customWidth="1"/>`)
    .join('');
  // ヘッダー行があるときだけ先頭行を固定する
  const pane = header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';

  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_SHEET}">`
    + `<dimension ref="A1:${colName(cols.length - 1)}${n}"/>`
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols>`
    + `<sheetData>${rows.join('')}</sheetData></worksheet>`;

  // ヘッダー行を太字にするための最小スタイル（s="1" が太字）
  const styles = `${XML_HEAD}<styleSheet xmlns="${NS_SHEET}">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';

  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
    { name: '_rels/.rels', bytes: enc.encode(`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', bytes: enc.encode(`${XML_HEAD}<workbook xmlns="${NS_SHEET}" xmlns:r="${NS_REL}"><sheets><sheet name="testdata" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', bytes: enc.encode(styles) },
    { name: 'xl/worksheets/sheet1.xml', bytes: enc.encode(sheet) },
  ]);
}

/* ---- Shift_JIS エンコード ----
 * TextEncoder は UTF-8 しか書き出せないため、TextDecoder('shift_jis') で
 * 全バイト列を1回だけ復号して逆引き表を作る（変換表を同梱せずCP932相当を得る）。 */
let SJIS = null;

function sjisTable() {
  if (SJIS) return SJIS;
  const seqs = [];
  const probe = [];
  const push = (seq) => { seqs.push(seq); probe.push(...seq, 0x0a); }; // 0x0a は trail バイトに現れないため区切りに使える
  for (let b = 0x20; b <= 0x7e; b++) push([b]);
  for (let b = 0xa1; b <= 0xdf; b++) push([b]); // 半角カナ
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail !== 0x7f) push([lead, trail]);
    }
  }
  const chars = new TextDecoder('shift_jis').decode(Uint8Array.from(probe)).split('\n');
  const map = new Map();
  for (let i = 0; i < seqs.length; i++) {
    const c = chars[i];
    // 未定義領域は U+FFFD になる。重複定義は先に現れる（＝JIS標準側の）バイト列を採用する
    if (c && [...c].length === 1 && c !== '�' && !map.has(c)) map.set(c, seqs[i]);
  }
  map.set('\n', [0x0a]);
  map.set('\r', [0x0d]);
  map.set('\t', [0x09]);
  // CP932（Windows/Excel）とUnicodeの対応差。復号表は片側しか持たないため別名を補う
  // 例: 波ダッシュ U+301C は Windows では 0x8160（U+FF5E 側）に載っている
  for (const [from, to] of [['〜', '～'], ['−', '－'], ['¢', '￠'], ['£', '￡'],
    ['¬', '￢'], ['‖', '∥'], ['—', '―']]) {
    if (!map.has(from) && map.has(to)) map.set(from, map.get(to));
  }
  SJIS = map;
  return map;
}

/** Shift_JIS のバイト列にする。表現できない文字は '?' に置換し件数を返す */
function sjisEncode(text) {
  const map = sjisTable();
  const out = [];
  let unencodable = 0;
  for (const ch of String(text)) {
    const seq = map.get(ch);
    if (seq) {
      for (const b of seq) out.push(b);
    } else {
      unencodable++;
      out.push(0x3f); // '?'
    }
  }
  return { bytes: Uint8Array.from(out), unencodable };
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

/** テキストをバイト列にする。encoding: 'utf-8' | 'shift_jis'（Shift_JIS に BOM は無い） */
function encodeText(text, opts = {}) {
  if (opts.encoding === 'shift_jis') {
    const r = sjisEncode(text);
    return { bytes: r.bytes, unencodable: r.unencodable, encoding: 'shift_jis', has_bom: false };
  }
  const body = new TextEncoder().encode(text);
  const bytes = opts.bom ? Uint8Array.from([...BOM_UTF8, ...body]) : body;
  return { bytes, unencodable: 0, encoding: 'utf-8', has_bom: !!opts.bom };
}

/* ---- 文字種・境界値テキスト ---- */
const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  symbol: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  escape: '<>&"\'/\\',
  hiragana: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
  katakana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  kanji: '亜以宇江於加喜久計古佐之寸世曽太知川天登奈仁奴祢乃波比不部保末美武女毛也由与良利留礼呂和',
  mixed: '日本語のテスト文字列サンプル漢字カタカナひらがな混在',
  zenkaku_alnum: 'ＡＢＣＤＥＦＧＨＩＪ０１２３４５６７８９',
  hankaku_kana: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ',
  kisyu: '①②③④⑤⑥㈱㈲℡髙﨑濵德',
  emoji: '😀🍣🎉🚀🌸🐱🔥🎌⭐🍺',
  // 不可視文字はエスケープで書く（見た目で消えるとメンテナンスで壊れるため）
  space: ' \u3000あA1',
  zerowidth: 'あ\u200bい\u200cう\ufeff', // ZWSP / ZWNJ / ゼロ幅ノーブレークスペース
};

/** preset の文字を先頭から巡回して、ちょうど n コードポイントの文字列を作る */
function buildText(preset, n) {
  const set = [...(CHARSETS[preset] || CHARSETS.alnum)];
  const len = Math.max(0, n);
  const out = [];
  for (let i = 0; i < len; i++) out.push(set[i % set.length]);
  // 前後空白のトリム挙動を確かめるプリセットは、先頭を半角スペース・末尾を全角スペースに固定する
  if (preset === 'space' && len >= 2) {
    out[0] = ' ';
    out[len - 1] = '　';
  }
  return out.join('');
}

function textStats(s) {
  let graphemes = [...s].length;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    graphemes = [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)].length;
  }
  return {
    code_points: [...s].length,
    utf16: s.length,
    graphemes,
    utf8_bytes: new TextEncoder().encode(s).length,
  };
}

/** 境界値テスト用に n-1 / n / n+1 の3本を返す */
function generateBoundaryText(preset, n) {
  const len = Math.min(Math.max(parseInt(n, 10) || 1, 1), 10000);
  return [len - 1, len, len + 1].map((l) => {
    const text = buildText(preset, l);
    return { length: l, label: l === len ? 'N' : l < len ? 'N-1' : 'N+1', text, ...textStats(text) };
  });
}

/* ---- MCPツールの入口 ---- */

const PRESETS = Object.keys(CHARSETS);

/**
 * mode: 'records'（既定）… ダミーレコードを CSV/TSV/JSON/XLSX で返す
 * mode: 'text'          … 指定文字種で n-1 / n / n+1 文字ちょうどの文字列を返す
 */
export function generateTestData(opts = {}) {
  if (opts.mode === 'text') {
    const preset = opts.preset || 'mixed';
    if (!PRESETS.includes(preset)) throw new Error(`未対応の文字種: ${preset}（${PRESETS.join(' / ')} のいずれか）`);
    return { mode: 'text', preset, length: Math.min(Math.max(parseInt(opts.length ?? 20, 10) || 1, 1), 10000), variants: generateBoundaryText(preset, opts.length ?? 20) };
  }

  const fields = (opts.fields && opts.fields.length ? opts.fields : DEFAULT_FIELDS).filter((f) => FIELDS.includes(f));
  if (!fields.length) throw new Error(`fields が不正です（${FIELDS.join(' / ')} から選ぶ）`);
  const format = opts.format || 'csv';
  if (!['csv', 'tsv', 'json', 'xlsx'].includes(format)) throw new Error(`未対応の形式: ${format}（csv / tsv / json / xlsx のいずれか）`);
  const encoding = opts.encoding || 'utf-8';
  if (!['utf-8', 'shift_jis'].includes(encoding)) throw new Error(`未対応の文字コード: ${encoding}（utf-8 / shift_jis のいずれか）`);
  const newline = opts.newline || 'LF';
  const header = opts.header !== false;

  const r = generateRecords({ rows: opts.rows ?? 10, locale: opts.locale, seed: opts.seed });

  // xlsx はZIP+XMLのバイナリなので、文字コード・改行コード・BOMの指定は対象外。
  // text には中身を確認できるようタブ区切りの表現を入れる（そのままExcelに貼れる）
  if (format === 'xlsx') {
    const bytes = buildXlsx(r.records, fields, { header });
    return {
      mode: 'records',
      rows: r.rows,
      locale: r.locale,
      seed: r.seed,
      fields,
      format,
      encoding: 'utf-8', // xlsx内部のXMLは常にUTF-8
      has_bom: false,
      newline: 'LF',
      bytes: bytes.length,
      unencodable: 0,
      note: 'xlsx はバイナリのため encoding / newline / bom の指定は無視される。text はタブ区切りのプレビューで、ファイル本体は base64（または outputPath）で受け取る。',
      text: serialize(r.records, fields, { format: 'tsv', newline: 'LF', header }),
      base64: Buffer.from(bytes).toString('base64'),
      _bytes: bytes,
    };
  }

  const text = serialize(r.records, fields, { format, newline, header });
  // Shift_JIS に BOM は無いため、指定されても付けない
  const enc = encodeText(text, { encoding, bom: encoding === 'utf-8' && !!opts.bom });

  return {
    mode: 'records',
    rows: r.rows,
    locale: r.locale,
    seed: r.seed, // 同じ seed を渡せば同じデータを再現できる
    fields,
    format,
    encoding: enc.encoding,
    has_bom: enc.has_bom,
    newline,
    bytes: enc.bytes.length,
    unencodable: enc.unencodable,
    text,
    // テキストだけでは表せないバイト列（Shift_JIS / BOM付き）のときだけ base64 も返す
    ...(enc.encoding === 'shift_jis' || enc.has_bom ? { base64: Buffer.from(enc.bytes).toString('base64') } : {}),
    _bytes: enc.bytes,
  };
}

export { FIELDS, DEFAULT_FIELDS, CHARSETS, PRESETS, generateRecords, serialize, buildXlsx, encodeText, generateBoundaryText, textStats, sjisEncode };
