/* 書類の中のAI向け命令文と見えない文字を探す（hidden_instruction_scan）
 * 判定のコアは FirstCHTools の site/kakushi/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' site/kakushi/lib.mjs) <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' hidden-instruction.mjs)
 *
 * 貼り付けた文（プレーンテキスト）から、AIへの命令らしい文（日英の辞書）・見えない文字・タグ文字などに隠れた文を探す。
 * HTML の解析・ファイルの読み込み・URL からの取得・AI による判定はしない。書いた人の意図も判定しない。
 * 完全ローカル処理・ネットワーク送信なし。 */

// ==================== ここからコア ====================
// 貼り付けた文（プレーンテキスト）から、①AIへの命令らしい文（日英の辞書）②見えない文字 ③タグ文字などに隠れた文 を探す。
// 書いた人の意図は判定しない。見つからなかったことは安全を意味しない（memo にも必ず書く）。
export const MAX_CHARS = 1000000;
export const MAX_HITS = 500;
export const MAX_RUNS = 500;

// 見えない文字の種類。tagflag は旗の絵文字（🏴＋タグ＋CANCEL TAG）の一部、vshide は2つ以上続いた異体字セレクタ（バイト列を埋める書き方）
export const INV_KINDS = ['tag', 'vshide', 'bidi', 'zw', 'ctrl', 'zwj', 'vs', 'tagflag'];
// 初期状態で消す種類（＝点検で数える「気をつける見えない文字」）。zwj・vs・tagflag は絵文字や漢字の字形に普通に使うので残す
export const DEFAULT_REMOVE = { tag: true, vshide: true, bidi: true, zw: true, ctrl: true, zwj: false, vs: false, tagflag: false };
export const HIT_KINDS = ['override', 'role', 'evaluate', 'hide', 'markup'];

export const LABEL = {
  ja: {
    override: '前の指示を打ち消す言い方', role: 'AIに呼びかける言い方', evaluate: '評価の結果を決めつける言い方',
    hide: '隠すように求める言い方', markup: 'AIへの指示文の書式',
    tag: 'タグ文字（見えない英数字）', vshide: '続いた異体字セレクタ（見えない文を埋められる）', bidi: '双方向の制御文字（文字の向きを変える）',
    zw: 'ゼロ幅・見えない文字', ctrl: '制御文字', zwj: '接合子（ZWJ・絵文字をつなぐ）', vs: '異体字セレクタ（絵文字・漢字の字形）',
    tagflag: '旗の絵文字のタグ',
  },
  en: {
    override: 'Tries to cancel earlier instructions', role: 'Speaks to an AI directly', evaluate: 'Dictates the evaluation result',
    hide: 'Asks to hide or leave something out', markup: 'Chat-prompt markup',
    tag: 'Tag characters (invisible letters)', vshide: 'Run of variation selectors (can carry hidden text)', bidi: 'Bidirectional controls (change text direction)',
    zw: 'Zero-width / invisible characters', ctrl: 'Control characters', zwj: 'Zero width joiner (joins emoji)', vs: 'Variation selectors (emoji / kanji forms)',
    tagflag: 'Tags of a flag emoji',
  },
};

const NAMES = {
  0x00AD: 'SOFT HYPHEN', 0x034F: 'COMBINING GRAPHEME JOINER', 0x061C: 'ARABIC LETTER MARK', 0x115F: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER', 0x180E: 'MONGOLIAN VOWEL SEPARATOR', 0x200B: 'ZERO WIDTH SPACE', 0x200C: 'ZERO WIDTH NON-JOINER',
  0x200D: 'ZERO WIDTH JOINER', 0x200E: 'LEFT-TO-RIGHT MARK', 0x200F: 'RIGHT-TO-LEFT MARK', 0x202A: 'LEFT-TO-RIGHT EMBEDDING',
  0x202B: 'RIGHT-TO-LEFT EMBEDDING', 0x202C: 'POP DIRECTIONAL FORMATTING', 0x202D: 'LEFT-TO-RIGHT OVERRIDE', 0x202E: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER', 0x2061: 'FUNCTION APPLICATION', 0x2062: 'INVISIBLE TIMES', 0x2063: 'INVISIBLE SEPARATOR', 0x2064: 'INVISIBLE PLUS',
  0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE',
  0x3164: 'HANGUL FILLER', 0xFEFF: 'ZERO WIDTH NO-BREAK SPACE', 0xFFA0: 'HALFWIDTH HANGUL FILLER', 0xE0001: 'LANGUAGE TAG', 0xE007F: 'CANCEL TAG',
};
const ZW = new Set([0x00AD, 0x034F, 0x115F, 0x1160, 0x180E, 0x200B, 0x200C, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x3164, 0xFEFF, 0xFFA0]);
const BIDI = new Set([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]);
// 改行として数える文字（行番号は物理行。\v \f は Word の改行がコピーで入ることがある）
const isBreak = (cp) => cp === 0x0A || cp === 0x0D || cp === 0x0B || cp === 0x0C || cp === 0x85 || cp === 0x2028 || cp === 0x2029;

export function kindOf(cp) {
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'tag';
  if (cp === 0x200D) return 'zwj';
  if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) return 'vs';
  if (BIDI.has(cp)) return 'bidi';
  if (ZW.has(cp)) return 'zw';
  if (isBreak(cp) || cp === 0x09) return null;
  if (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F)) return 'ctrl';
  return null;
}
export const hex = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
export function charName(cp) {
  if (NAMES[cp]) return NAMES[cp];
  if (cp >= 0xFE00 && cp <= 0xFE0F) return `VARIATION SELECTOR-${cp - 0xFE00 + 1}`;
  if (cp >= 0xE0100 && cp <= 0xE01EF) return `VARIATION SELECTOR-${cp - 0xE0100 + 17}`;
  if (cp === 0xE0020) return 'TAG SPACE';
  if (cp > 0xE0020 && cp < 0xE007F) return `TAG ${JSON.stringify(String.fromCharCode(cp - 0xE0000))}`;
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'TAG (unassigned)';
  return 'CONTROL';
}

// 辞書。ja は空白を除いた写し、en は空白をまとめた写し（どちらも NFKC・小文字）に当てる。
// [id, 種類, 写し, 辞書の語, 正規表現]
const S = '[、,]?';
const NEG = '(?:ない|ず|るな|ないで)';
const RULES_SRC = [
  ['j-ignore-prev', 'override', 'ja', 'これまでの指示を無視', `(?:これまで|今まで|いままで|以前|先ほど|前|上記|上|過去|既存|元)の(?:すべての|全ての|全部の|あらゆる)?(?:指示|命令|指令|プロンプト|ルール|設定|条件)(?:は|を)?${S}(?:すべて|全て)?(?:無視|忘れ|破棄|取り消|撤回|リセット)`],
  ['j-ignore', 'override', 'ja', '指示を無視して', `(?:指示|命令|プロンプト)(?:は|を)${S}(?:すべて|全て)?(?:無視|忘れ)(?:し|して|せよ|すること|しろ|しなさい|してください)`],
  ['j-ignore-criteria', 'override', 'ja', '評価基準を無視', `(?:評価|採点|審査|選考)(?:の)?(?:基準|ルール|方針|観点)(?:は|を)${S}(?:無視|適用しない|考慮しない|忘れ)`],
  ['j-new-order', 'override', 'ja', '新しい指示に従う', `(?:以下|次|下記|この)の(?:新しい|新たな|本当の|真の|優先の|最優先の)(?:指示|命令)(?:だけ|のみ)?に(?:必ず)?(?:従|したが)`],
  ['j-you-are-ai', 'role', 'ja', 'あなたはAI', `(?:あなた|貴方|君|おまえ|お前)は(?:今から|これから)?(?:ai|人工知能|aiアシスタント|言語モデル|チャットボット|採点者|評価者|審査員|面接官|採用担当者?|査読者)`],
  ['j-to-ai', 'role', 'ja', 'AIへの指示', `(?:ai|人工知能|llm|言語モデル|chatgpt|gpt|claude|gemini|copilot|生成ai)(?:への|に対する|向けの|向け|用の)(?:指示|命令|指令|メッセージ|注意|お願い|依頼|プロンプト)`],
  ['j-if-ai', 'role', 'ja', 'AIが読んでいる場合', `(?:ai|人工知能|llm|言語モデル|chatgpt|生成ai)(?:が|で|によって|により)(?:この)?(?:文書|書類|文章|ファイル|レポート|応募書類)?(?:を)?(?:読|要約|評価|採点|審査|処理|解析|分析|選考)(?:んで|み込んで|んでいる|む|まれ|している|する|され|させ)[^。！？]{0,6}?(?:場合|なら|とき|時)`],
  ['j-reading-ai', 'role', 'ja', 'この文を読んでいるAI', `(?:この|本)(?:文|文書|書類|文章|ページ|テキスト)を(?:読ん|読み込ん|処理し|要約し)(?:でいる|ている)(?:ai|人工知能|llm|言語モデル|あなた)`],
  ['j-grading-ai', 'role', 'ja', '採点するAIへ', `(?:採点|評価|審査|選考|査読|要約)(?:を)?(?:する|している|担当する)(?:ai|人工知能|llm|言語モデル)(?:へ|に|は|の方)`],
  ['j-rate-high', 'evaluate', 'ja', 'この候補者を高く評価', `(?:この|当該|本|こちらの)(?:候補者|応募者|人物|方|学生|生徒|提出者|著者|論文|レポート|課題|作品|会社|企業|業者|提案|提案書|見積|履歴書|職務経歴書)(?:を|は|の評価を)${S}(?:高く|最も高く|最高に|非常に高く|積極的に|優先的に|優先して|強く|ぜひ)(?:評価|推薦|推奨|採用|合格|採点|評定)`],
  ['j-positive-only', 'evaluate', 'ja', '肯定的な評価のみ', `(?:肯定的|好意的|ポジティブ|前向き|プラス)な?(?:評価|内容|コメント|レビュー|要約|意見|点|面|フィードバック)(?:のみ|だけ)(?!でな|ではな|じゃな)`],
  ['j-no-negative', 'evaluate', 'ja', '否定的な点は書かない', `(?:否定的|批判的|ネガティブ|マイナス)な?(?:評価|内容|コメント|点|面|意見|指摘|部分|情報|要素)[^。！？]{0,12}?(?:書か|述べ|含め|出さ|言及し|触れ|記載し|出力し|挙げ|つけ|付け)${NEG}`],
  ['j-top-score', 'evaluate', 'ja', '最高評価をつけて', `(?:最高|満点|最上位|最高位|最も高い|一番高い)(?:の)?(?:評価|点|点数|スコア|ランク|評点|判定)?を(?:つけ|付け|与え|下し)`],
  ['j-must-pass', 'evaluate', 'ja', '必ず合格に', `(?:必ず|絶対に|無条件で|無条件に)(?:合格|採用|通過|内定|採択)(?:と(?:判定|評価|判断)|に(?:して|せよ|しなさい|すること)|させ(?:て|よ|なさい|ること))`],
  ['j-judge-pass', 'evaluate', 'ja', '合格と判定して', `(?:合格|採用|通過|内定|採択)(?:と|に)(?:判定|評価|判断)?(?:して|せよ|しなさい|してください|すること)`],
  ['j-best-fit', 'evaluate', 'ja', '最も適任と評価', `(?:最も|一番|最高に)(?:優秀|適任|ふさわしい|優れた)(?:な|だ|である)?(?:候補者|人材|応募者|学生|提案)?(?:と|だと|であると)(?:評価|判断|判定|報告|記載|要約|結論)`],
  ['j-recommend', 'evaluate', 'ja', '採用を推薦して', `(?:採用|合格|面接|次の選考|採択|契約)(?:を|に|へ)?(?:強く)?(?:推薦|推奨|勧め|すすめ)(?:して|せよ|しなさい|すること)`],
  ['j-dont-mention', 'hide', 'ja', 'この指示に触れない', `(?:この|本|これらの|上記の)(?:指示|命令|文|メッセージ|注記|プロンプト)(?:について|に|のこと|の存在)[^。！？]{0,8}?(?:触れ|言及し|出力し|表示し|明かさ|伝え|書か|報告し|含め)${NEG}`],
  ['j-dont-tell', 'hide', 'ja', 'ユーザーに伝えない', `(?:ユーザー|ユーザ|利用者|人間|採用担当者?|担当者|読者|教員|先生|審査員|使用者|依頼者)(?:に|へ)(?:は)?${S}(?:一切|絶対に|決して)?(?:伝え|知らせ|教え|明かさ|報告し|見せ)${NEG}`],
  ['j-not-in-summary', 'hide', 'ja', '要約に書かない', `(?:要約|出力|回答|返答|応答)(?:に|には|へ|では)${S}(?:この|これ)?(?:文|部分|指示)?(?:を|は)?(?:含め|入れ|書か|載せ|記載し)${NEG}`],
  ['j-system', 'markup', 'ja', 'システムプロンプト', 'システムプロンプト|システム指示|システムメッセージ|開発者モード|ジェイルブレイク|脱獄プロンプト'],
  ['e-ignore-prev', 'override', 'en', 'ignore previous instructions', String.raw`\b(?:ignore|disregard|forget|override|bypass|skip) (?:all |any |each |every )?(?:of )?(?:the |your |my |these |those )?(?:previous|prior|above|earlier|preceding|former|original|initial|system|existing|other) (?:instructions?|prompts?|directions|directives|rules|guidelines|context|messages?|commands?|tasks?)\b`],
  ['e-ignore-all', 'override', 'en', 'ignore all instructions', String.raw`\b(?:ignore|disregard) (?:all|any|your|the) (?:instructions?|guidelines|rules|directions|prompts?)\b`],
  ['e-ignore-criteria', 'override', 'en', 'ignore the grading criteria', String.raw`\b(?:ignore|disregard) (?:the |your |any )?(?:grading|scoring|evaluation|review|assessment|marking|hiring|screening) (?:criteria|rubric|guidelines|rules|instructions)\b`],
  ['e-new-instr', 'override', 'en', 'new instructions:', String.raw`\b(?:new|updated|revised|real|actual|true) (?:instructions?|task|directives?) ?:`],
  ['e-as-ai', 'role', 'en', 'as an AI reviewer', String.raw`\bas an? (?:ai (?:reviewer|assistant|model|grader|screener|recruiter|evaluator|system)|automated (?:reviewer|grader|screener|system)|artificial intelligence|large language model|language model|chatbot|llm|ai)\b`],
  ['e-if-ai', 'role', 'en', 'if you are an AI', String.raw`\b(?:if|when|since) (?:you are|you're) (?:an? )?(?:ai|llm|large language model|language model|chatgpt|gpt|claude|gemini|copilot|chatbot|bot|automated|machine)\b`],
  ['e-note-ai', 'role', 'en', 'note to AI', String.raw`\b(?:note|message|instructions?|reminder|attention|prompt) (?:to|for) (?:the |any |all )?(?:ai assistants?|ai models?|ai|ais|llms?|language models?|chatgpt|gpt|claude|gemini|bots?)\b(?! (?:manager|director|team|department|engineer|developer))`],
  ['e-you-now', 'role', 'en', 'you are now', String.raw`\byou are now (?:an? |acting |operating |in (?:developer|admin|god|dan) mode)|\bfrom now on,? you (?:are|will|must)\b`],
  ['e-you-ai', 'role', 'en', 'you are an AI', String.raw`\byou are (?:an? )?(?:ai|llm|large language model|language model|chatbot|ai assistant)\b`],
  ['e-dear-ai', 'role', 'en', 'dear AI', String.raw`\b(?:dear|hello|hi|hey) (?:ai|llm|chatgpt|gpt|claude|gemini|copilot|language model)\b`],
  ['e-ai-must', 'role', 'en', 'AI reviewers must', String.raw`\b(?:ai|llm|automated) (?:reviewers?|graders?|screeners?|recruiters?|evaluators?) (?:must|should|shall|are instructed|need to)\b`],
  ['e-positive-review', 'evaluate', 'en', 'give a positive review only', String.raw`\b(?:give|write|provide|output|produce|generate|return) (?:a |an )?(?:only )?(?:positive|favou?rable|glowing) (?:review|feedback|evaluation|assessment|summary|rating|score|comments?|recommendation)\b`],
  ['e-only-positive', 'evaluate', 'en', 'only positive feedback', String.raw`\b(?:only|exclusively) (?:positive|favou?rable) (?:review|feedback|evaluation|assessment|summary|comments?|points)\b`],
  ['e-no-negatives', 'evaluate', 'en', 'do not highlight any negatives', String.raw`\b(?:do not|don't|never|avoid) (?:highlight|mention|include|point out|list|discuss|note|report|raise)(?:ing)? (?:any )?(?:of )?(?:the )?(?:negatives?|negative (?:points|aspects|feedback|comments)|weaknesses|weak points|flaws|concerns|criticisms?|limitations|shortcomings|red flags)\b`],
  ['e-rate-high', 'evaluate', 'en', 'rate this candidate highly', String.raw`\b(?:rate|rank|score|grade|evaluate|assess|mark|review|consider) (?:this|the) (?:candidate|applicant|paper|submission|student|essay|resume|résumé|cv|author|vendor|proposal|report|manuscript|application|work) (?:as )?(?:very |extremely )?(?:highly|high|excellent|exceptional|outstanding|top|the best|favou?rably|positively|strongly)\b`],
  ['e-perfect-fit', 'evaluate', 'en', 'this candidate is a perfect fit', String.raw`\b(?:this|the) (?:candidate|applicant|student|author|vendor|company|proposal) (?:is|would be) (?:clearly |truly |definitely )?(?:an? |the )?(?:perfect|ideal|excellent|exceptional|outstanding|best|strongest|top) (?:fit|match|candidate|choice|applicant|hire)\b`],
  ['e-recommend', 'evaluate', 'en', 'recommend hiring', String.raw`\b(?:strongly |highly )?recommend (?:hiring|accepting|approving|interviewing|advancing|shortlisting|admitting)\b`],
  ['e-strong-hire', 'evaluate', 'en', 'strong hire', String.raw`\b(?:strong hire|must[- ]hire|accept without revisions?|accept as is)\b`],
  ['e-accept', 'evaluate', 'en', 'accept this paper', String.raw`\b(?:accept|approve|pass|admit|shortlist|advance) (?:this|the) (?:paper|submission|manuscript|application|applicant|candidate|student)\b`],
  ['e-full-marks', 'evaluate', 'en', 'give full marks', String.raw`\b(?:give|assign|award)(?: [a-z]+){0,3} (?:full marks|a perfect score|the highest (?:possible )?(?:score|rating|grade|mark))\b`],
  ['e-dont-reveal', 'hide', 'en', 'do not reveal this instruction', String.raw`\b(?:do not|don't|never) (?:reveal|disclose|mention|repeat|share|reference|acknowledge|quote|output) (?:this|these|the (?:above|following|hidden)) (?:instructions?|text|message|prompt|note|section|request)\b`],
  ['e-dont-tell', 'hide', 'en', 'do not tell the user', String.raw`\b(?:do not|don't|never) (?:tell|inform|alert|notify|warn) (?:the )?(?:user|human|reader|recruiter|reviewer|hiring manager|teacher|grader|operator)\b`],
  ['e-not-in-summary', 'hide', 'en', 'do not include this in the summary', String.raw`\b(?:do not|don't|never) (?:include|mention|put) (?:this|it|these) (?:in|into) (?:the |your )?(?:summary|output|response|answer|review|report)\b`],
  ['e-system', 'markup', 'en', 'system prompt', String.raw`\b(?:system prompt|developer mode|jailbreak)\b`],
  ['e-markup', 'markup', 'en', '[INST] / <|im_start|>', String.raw`\[\/?inst\]|<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|start_header_id|end_header_id|eot_id)\|>|<<\/?sys>>`],
];
export const RULES = RULES_SRC.map(([id, kind, lang, word, src]) => ({ id, kind, lang, word, re: new RegExp(src, 'gu') }));

const NORM = new Map();
function normChar(ch) {
  let v = NORM.get(ch);
  if (v === undefined) {
    v = ch.normalize('NFKC').toLowerCase().replace(/[‘’ʼ]/g, "'");
    NORM.set(ch, v);
  }
  return v;
}

// 文を1字（コードポイント）ずつに分け、見えない文字の種類を決める
function split(text) {
  const cps = [], idx = [], kinds = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    cps.push(cp); idx.push(i); kinds.push(kindOf(cp));
    i += cp > 0xFFFF ? 2 : 1;
  }
  // 旗の絵文字（U+1F3F4 ＋ タグの英小文字・数字 ＋ CANCEL TAG）は隠れた文ではない
  for (let k = 0; k < cps.length; k++) {
    if (cps[k] !== 0x1F3F4 || kinds[k + 1] !== 'tag') continue;
    let e = k + 1;
    while (e < cps.length && cps[e] >= 0xE0030 && cps[e] <= 0xE007A && !(cps[e] > 0xE0039 && cps[e] < 0xE0061)) e++;
    if (e > k + 1 && cps[e] === 0xE007F) for (let j = k + 1; j <= e; j++) kinds[j] = 'tagflag';
  }
  // 異体字セレクタが2つ以上続くのは字形の指定ではない（バイト列を埋める書き方）
  for (let k = 0; k < cps.length; k++) {
    if (kinds[k] !== 'vs') continue;
    let e = k;
    while (e + 1 < cps.length && kinds[e + 1] === 'vs') e++;
    if (e > k) for (let j = k; j <= e; j++) kinds[j] = 'vshide';
    k = e;
  }
  return { cps, idx, kinds };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0D && text.charCodeAt(i + 1) === 0x0A) { i++; starts.push(i + 1); continue; }
    if (isBreak(c)) starts.push(i + 1);
  }
  return starts;
}
function lineOf(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}
const visible = (s) => [...s].filter((ch) => !kindOf(ch.codePointAt(0))).join('').replace(/\s+/g, ' ');

// 見えない文字を除き NFKC・小文字にした2つの写し（ja＝空白なし・en＝空白を1つに）と、元の位置への対応
function streams(text, sp) {
  const ja = [], jaS = [], jaE = [], en = [], enS = [], enE = [];
  for (let k = 0; k < sp.cps.length; k++) {
    if (sp.kinds[k]) continue;
    const s = sp.idx[k], e = s + (sp.cps[k] > 0xFFFF ? 2 : 1);
    const n = normChar(text.slice(s, e));
    for (const ch of n) {
      if (/\s/u.test(ch)) {
        if (en.length && en[en.length - 1] !== ' ') { en.push(' '); enS.push(s); enE.push(e); }
        continue;
      }
      ja.push(ch); jaS.push(s); jaE.push(e);
      en.push(ch); enS.push(s); enE.push(e);
    }
  }
  return { ja: { str: ja.join(''), arr: ja, s: jaS, e: jaE }, en: { str: en.join(''), arr: en, s: enS, e: enE } };
}

// 写しの中の UTF-16 位置を、写しの文字の番号に直す
function charIndex(arr) {
  const out = new Int32Array(arr.join('').length + 1);
  let u = 0;
  for (let k = 0; k < arr.length; k++) { for (let j = 0; j < arr[k].length; j++) out[u + j] = k; u += arr[k].length; }
  out[u] = arr.length;
  return out;
}

function findRules(st, onHit) {
  for (const lang of ['ja', 'en']) {
    const s = st[lang];
    if (!s.arr.length) continue;
    const ci = charIndex(s.arr);
    for (const r of RULES) {
      if (r.lang !== lang) continue;
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(s.str))) {
        if (!m[0].length) { r.re.lastIndex++; continue; }
        let a = ci[m.index], b = ci[m.index + m[0].length - 1];
        // en の写しの先頭・末尾の空白は元の位置に含めない
        if (s.arr[a] === ' ') a++;
        if (s.arr[b] === ' ' && b > a) b--;
        onHit(r, s.s[a], s.e[b]);
      }
    }
  }
}

// 隠れた文を読む（タグ文字→ASCII、続いた異体字セレクタ→バイト列→UTF-8）
function decodeTags(cps) {
  return cps.map((cp) => (cp >= 0xE0020 && cp <= 0xE007E ? String.fromCharCode(cp - 0xE0000) : cp === 0xE0001 || cp === 0xE007F ? '' : '�')).join('');
}
function decodeVs(cps) {
  const bytes = Uint8Array.from(cps.map((cp) => (cp <= 0xFE0F ? cp - 0xFE00 : cp - 0xE0100 + 16)));
  return new TextDecoder('utf-8').decode(bytes);
}

function dedupe(hits) {
  hits.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
  const out = [];
  for (const h of hits) {
    const p = out[out.length - 1];
    if (p && p.source === h.source && p.hiddenIndex === h.hiddenIndex && h.start < p.end) {
      if (h.end > p.end) p.end = h.end;
      if (!p.words.includes(h.word)) p.words.push(h.word);
      continue;
    }
    out.push({ ...h, words: [h.word] });
  }
  return out;
}

export function scan(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > MAX_CHARS) throw new RangeError(`text is longer than ${MAX_CHARS} characters`);
  const sp = split(text);
  const starts = lineStarts(text);
  const pos = (i) => { const l = lineOf(starts, i); return { line: l + 1, col: [...text.slice(starts[l], i)].length + 1 }; };

  // ② 見えない文字（同じ行で続く同じ種類はひとまとめ）
  const byKind = Object.fromEntries(INV_KINDS.map((k) => [k, 0]));
  const runs = [];
  let invTotal = 0, runsOmitted = 0;
  for (let k = 0; k < sp.cps.length; k++) {
    const kind = sp.kinds[k];
    if (!kind) continue;
    let e = k;
    while (e + 1 < sp.cps.length && sp.kinds[e + 1] === kind) e++;
    const n = e - k + 1;
    byKind[kind] += n; invTotal += n;
    if (runs.length < MAX_RUNS) {
      const p = pos(sp.idx[k]);
      const codes = sp.cps.slice(k, Math.min(e + 1, k + 8));
      runs.push({ kind, line: p.line, col: p.col, index: sp.idx[k], count: n, codes: codes.map(hex), name: charName(sp.cps[k]), _cps: sp.cps.slice(k, e + 1) });
    } else runsOmitted++;
    k = e;
  }

  // ③ 隠れた文
  const hidden = [];
  for (const r of runs) {
    if (r.kind !== 'tag' && r.kind !== 'vshide') continue;
    const t = r.kind === 'tag' ? decodeTags(r._cps) : decodeVs(r._cps);
    if (t.trim()) hidden.push({ line: r.line, col: r.col, index: r.index, kind: r.kind, count: r.count, text: t });
  }
  for (const r of runs) delete r._cps;

  // ① 命令らしい文（本文と、隠れた文の中）
  const raw = [];
  findRules(streams(text, sp), (r, s, e) => raw.push({ source: 'text', start: s, end: e, rule: r.id, kind: r.kind, word: r.word }));
  hidden.forEach((h, hi) => {
    const hsp = split(h.text);
    findRules(streams(h.text, hsp), (r, s, e) => raw.push({ source: 'hidden', hiddenIndex: hi, start: s, end: e, rule: r.id, kind: r.kind, word: r.word }));
  });
  const hits = [];
  let hitsOmitted = 0;
  for (const h of dedupe(raw)) {
    if (hits.length >= MAX_HITS) { hitsOmitted++; continue; }
    if (h.source === 'text') {
      const a = pos(h.start), b = lineOf(starts, Math.max(h.start, h.end - 1)) + 1;
      const ls = starts[a.line - 1], le = a.line < starts.length ? starts[a.line] : text.length;
      const before = visible(text.slice(Math.max(ls, h.start - 60), h.start)).replace(/^\s+/, '');
      const after = visible(text.slice(h.end, Math.min(Math.max(le, h.end), h.end + 60))).replace(/\s+$/, '');
      hits.push({ source: 'text', line: a.line, endLine: b, col: a.col, text: visible(text.slice(h.start, h.end)).trim(), before: before.slice(-30), after: after.slice(0, 30), kind: h.kind, rule: h.rule, words: h.words });
    } else {
      const hd = hidden[h.hiddenIndex];
      hits.push({ source: 'hidden', line: hd.line, endLine: hd.line, col: hd.col, hiddenIndex: h.hiddenIndex, text: hd.text.slice(h.start, h.end), before: hd.text.slice(Math.max(0, h.start - 30), h.start), after: hd.text.slice(h.end, h.end + 30), kind: h.kind, rule: h.rule, words: h.words });
    }
  }
  hits.sort((x, y) => x.line - y.line || x.col - y.col || (x.source === 'hidden') - (y.source === 'hidden'));

  return {
    chars: sp.cps.length,
    lines: text.length ? starts.length : 0,
    counts: { hits: hits.length + hitsOmitted, invisible: INV_KINDS.filter((k) => DEFAULT_REMOVE[k]).reduce((a, k) => a + byKind[k], 0), kept: INV_KINDS.filter((k) => !DEFAULT_REMOVE[k]).reduce((a, k) => a + byKind[k], 0), hidden: hidden.length },
    hits, hitsOmitted,
    invisible: { total: invTotal, byKind, runs, runsOmitted },
    hidden,
  };
}

// 選んだ種類の見えない文字を消す。marks は消した位置（整えた文の中の位置）
export function clean(text, remove = DEFAULT_REMOVE) {
  const rm = { ...DEFAULT_REMOVE, ...(remove || {}) };
  const sp = split(text);
  const removed = Object.fromEntries(INV_KINDS.map((k) => [k, 0]));
  const out = [], marks = [];
  let len = 0;
  for (let k = 0; k < sp.cps.length; k++) {
    const kind = sp.kinds[k];
    const ch = String.fromCodePoint(sp.cps[k]);
    if (kind && rm[kind]) {
      removed[kind]++;
      const p = marks[marks.length - 1];
      if (p && p.at === len && p.kind === kind) { p.count++; p.codes.length < 8 && p.codes.push(hex(sp.cps[k])); } else marks.push({ at: len, kind, count: 1, codes: [hex(sp.cps[k])] });
      continue;
    }
    out.push(ch); len += ch.length;
  }
  return { text: out.join(''), removed, total: Object.values(removed).reduce((a, b) => a + b, 0), marks };
}

const MEMO = {
  ja: {
    head: '【AIに渡す前の点検メモ】',
    hits: (n) => `AIへの命令らしい文: ${n}件`,
    hit: (h, L) => `・${h.line}行目${h.source === 'hidden' ? '（隠れた文の中）' : ''}「${h.text}」— ${L[h.kind]}`,
    more: (n) => `・ほか${n}件`,
    inv: (n, parts) => `見えない文字: ${n}個${parts ? `（${parts}）` : ''}`,
    kept: (n, parts) => `残してよいことが多い文字: ${n}個（${parts}）`,
    part: (k, n, L) => `${L[k].replace(/（.*$/, '')} ${n}`,
    hidden: (h) => `隠れた文: ${h.line}行目「${h.text}」（${h.kind === 'tag' ? 'タグ文字' : '異体字セレクタ'}を読み直したもの）`,
    note: '※見つからなかった＝安全、ではありません。辞書にない言い方・画像の中の文字・ファイルの書式は調べていません。書いた人の意図も判断していません。',
  },
  en: {
    head: '[Check before giving this to an AI]',
    hits: (n) => `AI-instruction-like phrases: ${n}`,
    hit: (h, L) => `- Line ${h.line}${h.source === 'hidden' ? ' (inside hidden text)' : ''}: "${h.text}" — ${L[h.kind]}`,
    more: (n) => `- and ${n} more`,
    inv: (n, parts) => `Invisible characters: ${n}${parts ? ` (${parts})` : ''}`,
    kept: (n, parts) => `Usually fine to keep: ${n} (${parts})`,
    part: (k, n, L) => `${L[k].replace(/ \(.*$/, '')} ${n}`,
    hidden: (h) => `Hidden text: line ${h.line} "${h.text}" (decoded from ${h.kind === 'tag' ? 'tag characters' : 'variation selectors'})`,
    note: 'Note: nothing found does not mean safe. Phrases outside the list, text inside images and file formatting were not checked. This does not judge what the writer meant.',
  },
};
const cut = (s, n) => { const a = [...String(s).replace(/\s+/g, ' ')]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };

// 採用担当や上司へそのまま送れる数行の確認メモ（「見つからなかった＝安全ではない」の注記を必ず付ける）
export function memo(result, lang = 'ja') {
  const M = MEMO[lang === 'en' ? 'en' : 'ja'], L = LABEL[lang === 'en' ? 'en' : 'ja'];
  const lines = [M.head, M.hits(result.counts.hits)];
  const shown = result.hits.slice(0, 10);
  for (const h of shown) lines.push(M.hit({ ...h, text: cut(h.text, 60) }, L));
  if (result.counts.hits > shown.length) lines.push(M.more(result.counts.hits - shown.length));
  const sep = lang === 'en' ? ', ' : '・';
  const parts = (keep) => INV_KINDS.filter((k) => !DEFAULT_REMOVE[k] === keep && result.invisible.byKind[k]).map((k) => M.part(k, result.invisible.byKind[k], L)).join(sep);
  lines.push(M.inv(result.counts.invisible, parts(false)));
  if (result.counts.kept) lines.push(M.kept(result.counts.kept, parts(true)));
  for (const h of result.hidden.slice(0, 5)) lines.push(M.hidden({ ...h, text: cut(h.text, 120) }));
  lines.push(M.note);
  return lines.join('\n');
}
// ==================== ここまでコア ====================

export class HiddenInstructionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function hiddenInstructionTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  if (typeof opts.text !== 'string') throw new HiddenInstructionError('NO_TEXT', 'text (plain text of the document) is required');
  if (opts.text.length > MAX_CHARS) throw new HiddenInstructionError('TOO_LONG', `text: up to ${MAX_CHARS} characters`);
  const r = scan(opts.text);
  const out = {
    ...r,
    hits: r.hits.map((h) => ({ ...h, reason: LABEL[lang][h.kind] })),
    invisible: { ...r.invisible, runs: r.invisible.runs.map((x) => ({ ...x, label: LABEL[lang][x.kind] })) },
    memo: memo(r, lang),
  };
  if (opts.clean) {
    const remove = { ...DEFAULT_REMOVE };
    for (const k of INV_KINDS) if (opts.remove && typeof opts.remove[k] === 'boolean') remove[k] = opts.remove[k];
    const c = clean(opts.text, remove);
    out.cleaned = { text: c.text, removed: c.removed, total: c.total };
  }
  return out;
}
