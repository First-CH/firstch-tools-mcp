#!/usr/bin/env node
// First CH Tools MCP サーバー（stdio）
// 導入例: npx -y @first-ch/tools-mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { contrastCheck, countChars, buildLlmsTxt, buildJsonLd, analyzeEncoding, convertEncoding } from './lib.mjs';
import { generateTestData, FIELDS, DEFAULT_FIELDS, PRESETS } from './testdata.mjs';
import { convertToWebp } from './webp.mjs';
import { renderMarp } from './marp.mjs';
import { diffCheck } from './diff.mjs';
import { cronExplain } from './cron.mjs';
import { base64Convert } from './base64.mjs';
import { urlParams } from './url.mjs';
import { htmlEscape } from './html-escape.mjs';
import { jsonToYaml, yamlToJson } from './json-yaml.mjs';
import { pxRemConvert } from './px-rem.mjs';
import { colorConvert } from './color.mjs';
import { hashGenerate } from './hash.mjs';

const { version } = createRequire(import.meta.url)('./package.json');
const server = new McpServer({ name: 'firstch-tools', version });

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// 社内利用の計測（tools-strategy.md KPI 5）。環境変数を設定したときだけローカルJSONLに追記する
// （opt-in・未設定なら一切記録しない）。ネットワーク送信は一切しない。
// 集計は FirstCHOps 側 scripts/tools/tools-usage-report.py。計測失敗でツール本体は止めない。
const USAGE_LOG = process.env.FIRSTCH_TOOLS_USAGE_LOG; // 未設定なら記録しない（opt-in）
const logUsage = (tool) =>
  USAGE_LOG
    ? appendFile(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), tool, source: 'mcp' }) + '\n').catch(() => {})
    : Promise.resolve();

server.registerTool(
  'contrast_check',
  {
    title: 'WCAGコントラスト比チェック',
    description:
      '文字色と背景色のWCAG 2.1コントラスト比を計算し、AA/AAA基準（通常/大テキスト・UI部品）の合否を返す。' +
      'Webデザインの配色検証・アクセシビリティチェックに使う。',
    inputSchema: {
      fg: z.string().describe('文字色（hex。例: #333333 / 333 / fff）'),
      bg: z.string().describe('背景色（hex。例: #ffffff）'),
    },
  },
  async ({ fg, bg }) => {
    await logUsage('contrast_check');
    return asText(contrastCheck(fg, bg));
  },
);

server.registerTool(
  'count_chars',
  {
    title: '文字数カウント（Xウェイト対応）',
    description:
      '日本語テキストの文字数（書記素単位）・全角/半角内訳・行数と、X(Twitter)の投稿ウェイト' +
      '（全角=2・半角=1・URL=一律23、上限280）を返す。SNS投稿や文字数制限のあるフォーム入力の検証に使う。',
    inputSchema: {
      text: z.string().describe('カウント対象のテキスト'),
    },
  },
  async ({ text }) => {
    await logUsage('count_chars');
    return asText(countChars(text));
  },
);

server.registerTool(
  'webp_convert',
  {
    title: '画像→WebP変換',
    description:
      'PNG/JPEG画像ファイルをWebPへ変換して保存する。エンコーダは tools.first-ch.com/webp/ と同一の' +
      'libwebp WASM（品質既定80）。Web制作の画像最適化・納品前の軽量化に使う。' +
      '入力は絶対パス。出力先を省略すると入力と同じ場所に拡張子.webpで保存する。',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('変換するPNG/JPEGファイルの絶対パスの配列'),
      quality: z.number().int().min(1).max(100).optional().describe('品質1-100（既定80）'),
      outputDir: z.string().optional().describe('出力先ディレクトリ（省略時は各入力と同じ場所）'),
    },
  },
  async ({ paths, quality, outputDir }) => {
    await logUsage('webp_convert');
    const { join, basename } = await import('node:path');
    const results = [];
    for (const p of paths) {
      try {
        const output = outputDir ? join(outputDir, basename(p).replace(/\.[^.]+$/, '') + '.webp') : undefined;
        results.push(await convertToWebp(p, { quality, output }));
      } catch (e) {
        results.push({ input: p, error: String(e.message || e) });
      }
    }
    return asText({ converted: results.filter((r) => !r.error).length, results });
  },
);

server.registerTool(
  'jsonld_generate',
  {
    title: 'JSON-LD構造化データ生成',
    description:
      'schema.org準拠のJSON-LD構造化データを生成する（tools.first-ch.com/jsonld/ と同一ロジック）。' +
      '対応タイプ: organization（会社情報）/ faqpage（よくある質問）/ service（提供サービス）/ breadcrumb（パンくず）。' +
      '空の項目は出力から自動で省略される。返り値は json オブジェクトと <script> スニペット。',
    inputSchema: {
      type: z.enum(['organization', 'faqpage', 'service', 'breadcrumb']).describe('スキーマタイプ'),
      organization: z
        .object({
          name: z.string().optional(),
          alternateName: z.string().optional(),
          url: z.string().optional(),
          logo: z.string().optional(),
          description: z.string().optional(),
          sameAs: z.array(z.string()).optional().describe('SNS・外部プロフィールURL'),
        })
        .optional()
        .describe('type=organization のときの項目'),
      faq: z
        .array(z.object({ q: z.string().describe('質問'), a: z.string().describe('回答') }))
        .optional()
        .describe('type=faqpage のときのQ&Aリスト'),
      service: z
        .object({
          name: z.string().optional(),
          serviceType: z.string().optional(),
          description: z.string().optional(),
          url: z.string().optional(),
          areaServed: z.string().optional(),
          providerName: z.string().optional(),
          providerUrl: z.string().optional(),
        })
        .optional()
        .describe('type=service のときの項目'),
      breadcrumb: z
        .array(z.object({ name: z.string(), url: z.string().optional().describe('最下層（現在ページ）は省略可') }))
        .optional()
        .describe('type=breadcrumb のときの階層リスト（上から position 1,2,3…）'),
    },
  },
  async ({ type, organization, faq, service, breadcrumb }) => {
    await logUsage('jsonld_generate');
    const fields = { organization, faqpage: { faq }, service, breadcrumb: { items: breadcrumb } }[type];
    return asText(buildJsonLd(type, fields || {}));
  },
);

server.registerTool(
  'llmstxt_generate',
  {
    title: 'llms.txt 生成',
    description:
      '生成AI・AI検索にサイト概要を伝える llms.txt（llmstxt.org 提案フォーマット準拠）を生成する' +
      '（tools.first-ch.com/llms-txt/ と同一ロジック）。生成テキストをサイトのルート（/llms.txt）に設置して使う。',
    inputSchema: {
      siteName: z.string().describe('サイト名（H1になる）'),
      summary: z.string().optional().describe('サイト概要（引用ブロックになる・改行可）'),
      notes: z.string().optional().describe('補足説明（自由記述の段落）'),
      sections: z
        .array(
          z.object({
            title: z.string().describe('セクション見出し（例: Main Pages / Optional）'),
            links: z.array(
              z.object({
                title: z.string().describe('ページタイトル'),
                url: z.string().describe('ページURL'),
                note: z.string().optional().describe('1行説明'),
              }),
            ),
          }),
        )
        .optional()
        .describe('リンクセクション（順に出力される）'),
    },
  },
  async (spec) => {
    await logUsage('llmstxt_generate');
    return asText({ text: buildLlmsTxt(spec) });
  },
);

server.registerTool(
  'encoding_convert',
  {
    title: '文字コード・改行コード変換',
    description:
      'CSV/テキストの文字コード（UTF-8 / Shift_JIS）・BOM有無・改行コード（CRLF/LF/CR）を判定し、UTF-8へ変換する。' +
      '顧客から受け取ったCSVの文字化け調査、フォーム取り込みデータの前処理、' +
      'リポジトリ内ファイルの改行コード事故（CRLFがLFに書き換わる等）の確認に使う。' +
      'mode=analyze なら判定のみ、mode=convert なら変換後のテキストとbase64を返す。',
    inputSchema: {
      base64: z.string().describe('対象ファイルの内容（base64）。テキストを直接渡す場合は text を使う'),
      text: z.string().optional().describe('base64の代わりにテキストを直接渡す場合（UTF-8として扱う）'),
      mode: z.enum(['analyze', 'convert']).optional().describe('既定 analyze。convert で変換結果を返す'),
      encoding: z.enum(['utf-8', 'shift_jis']).optional().describe('入力の文字コード。省略時は自動判定'),
      newline: z.enum(['LF', 'CRLF', 'CR']).optional().describe('変換後の改行コード（mode=convert のとき）'),
      bom: z.boolean().optional().describe('変換後にUTF-8 BOMを付けるか（既定 false）'),
    },
  },
  async ({ base64, text, mode, encoding, newline, bom }) => {
    await logUsage('encoding_convert');
    if (!base64 && text === undefined) throw new Error('base64 か text のどちらかが必要です');
    const bytes = base64
      ? Uint8Array.from(Buffer.from(base64, 'base64'))
      : new TextEncoder().encode(text);
    if (mode === 'convert') return asText(convertEncoding(bytes, { encoding, newline, bom }));
    const { text: _drop, ...info } = analyzeEncoding(bytes, encoding);
    return asText(info);
  },
);

server.registerTool(
  'marp_render',
  {
    title: 'Marp Markdown→スライド レンダリング',
    description:
      'Marp Markdown をスライドへレンダリングし、HTML（テーマCSSをインラインした自己完結ファイル）や PDF を書き出す。' +
      'AIが生成したスライド用Markdownをそのまま渡せば描画まで完結する（社内の marp ビルドの定型化・顧客配布資料の生成に使う）。' +
      '和文テーマ firstch（firstch-design 準拠・紙/墨/朱・IBM Plex Sans JP）を同梱し、既定テーマにする。' +
      'Markdown 側の Marp フロントマター（例: theme:/paginate:/size:/`<!-- _class: lead -->`）はそのまま効く。' +
      'PDF はローカルの Chrome/Chromium を headless で呼び出して生成する（未検出なら HTML のみ返し理由を添える。' +
      '環境変数 MARP_CHROME_PATH で実行ファイルを明示可）。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      markdown: z.string().optional().describe('Marp Markdown 本文（inputPath と排他・どちらか必須）'),
      inputPath: z.string().optional().describe('Markdownファイルの絶対パス（markdown 未指定時に読み込む）'),
      theme: z
        .enum(['firstch', 'default', 'gaia', 'uncover'])
        .optional()
        .describe('既定テーマ（既定 firstch＝和文）。Markdown内の theme 指示が優先される'),
      formats: z
        .array(z.enum(['html', 'pdf']))
        .optional()
        .describe("出力フォーマット（既定 ['html']）。['html','pdf'] で両方"),
      outputPath: z
        .string()
        .optional()
        .describe('出力ファイルのベースパス（拡張子は自動。省略時は inputPath 準拠、無ければ一時ディレクトリ）'),
      title: z.string().optional().describe('HTML の <title>（既定 "Marp slides"）'),
    },
  },
  async ({ markdown, inputPath, theme, formats, outputPath, title }) => {
    await logUsage('marp_render');
    let md = markdown;
    let outBase = outputPath;
    let docTitle = title;
    if ((md === undefined || md === '') && inputPath) {
      const { readFile } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');
      md = await readFile(inputPath, 'utf8');
      if (!outBase) outBase = inputPath; // 既定は入力と同じ場所・同名
      if (!docTitle) docTitle = basename(inputPath, extname(inputPath));
    }
    if (md === undefined || md === '') throw new Error('markdown か inputPath のどちらかが必要です');
    return asText(await renderMarp(md, { theme, formats, outputPath: outBase, title: docTitle }));
  },
);

server.registerTool(
  'testdata_generate',
  {
    title: 'テストデータ生成（ダミーCSV/JSON/Excel・境界値テキスト）',
    description:
      'フォーム入力テスト・CSV取り込みテスト用のダミーデータを生成する。' +
      'mode=records（既定）は氏名・フリガナ・住所・郵便番号・メール・電話番号などをCSV/TSV/JSON/XLSXで返し、' +
      '文字コード（UTF-8 / Shift_JIS）・BOM・改行コード（LF/CRLF）を指定できる。' +
      'format=xlsx は Excel の .xlsx ファイル（バイナリ）を base64 で返す。outputPath を併せて渡すとファイルに書き出せる。' +
      'mode=text は maxlength の境界値テスト用に、指定文字種で n-1 / n / n+1 文字ちょうどの文字列を返す。' +
      '生成データはすべて架空（メールは RFC 2606 の example.com 系）。seed を渡すと同じデータを再現できる。',
    inputSchema: {
      mode: z.enum(['records', 'text']).optional().describe('既定 records。text は文字種・境界値テキスト'),
      rows: z.number().int().min(1).max(1000).optional().describe('行数（既定10・最大1000）'),
      fields: z
        .array(z.enum(FIELDS))
        .optional()
        .describe(`出力する列（既定: ${DEFAULT_FIELDS.join(',')}）。locale=en では name_kana / name_romaji は空になる`),
      format: z.enum(['csv', 'tsv', 'json', 'xlsx']).optional().describe('出力形式（既定 csv）。xlsx は Excel ファイルを base64 で返す'),
      locale: z.enum(['ja', 'en']).optional().describe('データの言語（既定 ja。氏名・住所・電話番号の体系が変わる）'),
      encoding: z.enum(['utf-8', 'shift_jis']).optional().describe('文字コード（既定 utf-8）。shift_jis のときは base64 も返す。xlsx では無視される'),
      newline: z.enum(['LF', 'CRLF']).optional().describe('改行コード（既定 LF）。xlsx では無視される'),
      bom: z.boolean().optional().describe('UTF-8 BOMを付けるか（既定 false・Excelで開くCSV向け）。xlsx では無視される'),
      header: z.boolean().optional().describe('ヘッダー行を付けるか（既定 true・csv/tsv/xlsxのみ）'),
      seed: z.string().optional().describe('乱数シード。同じ値なら常に同じデータを生成する（省略時はランダム）'),
      preset: z.enum(PRESETS).optional().describe('mode=text の文字種（既定 mixed）'),
      length: z.number().int().min(1).max(10000).optional().describe('mode=text の文字数N（既定20・最大10000）'),
      outputPath: z.string().optional().describe('指定するとその絶対パスへファイルとして書き出す（mode=records のみ・format=xlsx では実質必須）'),
    },
  },
  async (opts) => {
    await logUsage('testdata_generate');
    const { _bytes, ...result } = generateTestData(opts);
    if (opts.outputPath && result.mode === 'records') {
      await writeFile(opts.outputPath, _bytes);
      result.output = opts.outputPath;
      // ファイルに書けたなら base64 は重複した重い情報でしかない
      delete result.base64;
    }
    return asText(result);
  },
);

server.registerTool(
  'diff_check',
  {
    title: 'テキスト・コード差分チェック',
    description:
      '2つのテキスト（またはファイル）を比較し、追加・削除・変更の件数と unified diff（.patch）を返す' +
      '（tools.first-ch.com/diff/ と同一ロジック）。原稿の推敲差分の確認、コード修正のレビュー、' +
      '設定ファイルの比較、AIが書き換えた文章の変更点の抽出に使う。' +
      '行の対応づけは patience diff（両方に1回だけ現れる行をアンカーに分割）＋アンカーの取れない範囲だけ Myers。' +
      'format=blocks / both では、変更行のペアを語単位（英数字はひとかたまり・和文は1文字ずつ）で比較した ' +
      'changed_parts も返すため、「どの語が変わったか」まで取れる。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      a: z.string().optional().describe('変更前のテキスト（pathA と排他・どちらか必須）'),
      b: z.string().optional().describe('変更後のテキスト（pathB と排他・どちらか必須）'),
      pathA: z.string().optional().describe('変更前ファイルの絶対パス（a 未指定時に読み込む・UTF-8）'),
      pathB: z.string().optional().describe('変更後ファイルの絶対パス（b 未指定時に読み込む・UTF-8）'),
      format: z
        .enum(['unified', 'blocks', 'both'])
        .optional()
        .describe('既定 unified。blocks は変更ブロックの配列、both は両方'),
      context: z.number().int().min(0).max(100).optional().describe('unified diff の前後コンテキスト行数（既定3）'),
      ignoreWhitespace: z.boolean().optional().describe('空白の違いを無視するか（既定 false）'),
      ignoreCase: z.boolean().optional().describe('大文字・小文字の違いを無視するか（既定 false）'),
      words: z.boolean().optional().describe('語単位の変更点も求めるか（既定 true・format=blocks/both で返る）'),
    },
  },
  async ({ a, b, pathA, pathB, format, context, ignoreWhitespace, ignoreCase, words }) => {
    await logUsage('diff_check');
    let textA = a;
    let textB = b;
    if (textA === undefined && pathA) {
      const { readFile } = await import('node:fs/promises');
      textA = await readFile(pathA, 'utf8');
    }
    if (textB === undefined && pathB) {
      const { readFile } = await import('node:fs/promises');
      textB = await readFile(pathB, 'utf8');
    }
    if (textA === undefined || textB === undefined) {
      throw new Error('a/b（テキスト）か pathA/pathB（ファイルパス）で、両側の入力を渡してください');
    }
    return asText(
      diffCheck(textA, textB, {
        format,
        context,
        ignoreWhitespace,
        ignoreCase,
        words,
        nameA: pathA || 'a',
        nameB: pathB || 'b',
      }),
    );
  },
);

server.registerTool(
  'cron_explain',
  {
    title: 'Cron式の解説＋次回発火日時',
    description:
      'Cron式（例: */15 * * * *）を人間向けの文へ読み下し、次回からの発火日時を返す' +
      '（tools.first-ch.com/cron/ と同一ロジック）。バッチ・CI・スケジューラの設定レビュー、' +
      '「この式は結局いつ動くのか」の確認、書き間違いの検出に使う。解釈は Vixie cron（crontab(5)）準拠で、' +
      '範囲・ステップ・列挙・JAN-DEC / SUN-SAT の名前・@daily 等の省略記法に対応し、6フィールドのときは先頭を秒として扱う。' +
      '「日」と「曜日」の両方が指定されたときの OR 解釈、範囲を割り切らない */n、存在しない日付（2月30日など）は warnings で知らせる。' +
      '発火日時はタイムゾーンの壁時計上で求めてから実時刻へ戻すため、夏時間のある地域でもずれない。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      expression: z.string().describe('Cron式（5フィールド「分 時 日 月 曜日」/ 秒付き6フィールド / @daily 等）'),
      timeZone: z
        .string()
        .optional()
        .describe('発火日時を求めるタイムゾーン（IANA名。既定 UTC。例: Asia/Tokyo）'),
      count: z.number().int().min(1).max(100).optional().describe('返す発火日時の件数（既定5・最大100）'),
      from: z.string().optional().describe('この日時より後を探す（ISO8601。既定は現在時刻）'),
    },
  },
  async ({ expression, timeZone, count, from }) => {
    await logUsage('cron_explain');
    return asText(cronExplain(expression, { timeZone, count, from }));
  },
);

server.registerTool(
  'base64_encode',
  {
    title: 'Base64 / Data URI エンコード・デコード',
    description:
      'テキストやファイルを Base64・data URI へ変換し、そのまま貼れる HTML <img> / CSS background-image の' +
      'スニペットも返す（tools.first-ch.com/base64/ と同一ロジック）。mode="decode" では Base64 や data URI を' +
      '元のバイト列へ戻し、outputPath を渡せばファイルとして書き出す。' +
      'アイコンやSVGのCSS埋め込み、メールHTML用の画像インライン化、APIやJWTで受け取ったBase64の中身の確認、' +
      'ログに出てきたdata URIの復元に使う。' +
      'SVGは base64（必ず約1.33倍になる）よりパーセントエンコードの方が小さいため両方の長さを返して短い方を既定にし、' +
      '& " < > # % と空白・非ASCIIを必ずエスケープするのでHTML属性にもCSSの url("…") にもそのまま貼れる。' +
      'デコードは標準/URLセーフのどちらでも、空白・改行混じりでも、パディングが欠けていても読み取り、' +
      'data URI が名乗るMIMEタイプより実際のマジックナンバー（PNG/JPEG/GIF/WebP/ico/PDF/zip/woff/woff2/SVG）から' +
      '判定した種類を優先する。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      mode: z.enum(['encode', 'decode']).optional().describe('既定 encode。decode は base64 を元のバイト列へ戻す'),
      text: z.string().optional().describe('encode: 変換するテキスト（UTF-8として符号化する。path と排他）'),
      path: z.string().optional().describe('encode: 変換するファイルの絶対パス（text と排他）'),
      base64: z.string().optional().describe('decode: Base64本体、または data:…;base64,… の全体'),
      outputPath: z.string().optional().describe('decode: 復元したバイト列を書き出す絶対パス（指定すると base64 は返さない）'),
      urlSafe: z.boolean().optional().describe('encode: URLセーフ（+/ を -_ に・パディング無し）にするか（既定 false）'),
      wrap: z.number().int().min(1).max(998).optional().describe('encode: n桁ごとに改行する（MIMEは76）'),
      dataUri: z.boolean().optional().describe('encode: data URI も返すか（path 指定時は常に返す）'),
      mimeType: z.string().optional().describe('encode: data URI のMIMEタイプ（未指定なら中身から判定）'),
      snippets: z.boolean().optional().describe('encode: HTML <img> / CSS background-image のスニペットも返すか（画像のみ）'),
    },
  },
  async (opts) => {
    await logUsage('base64_encode');
    return asText(await base64Convert(opts));
  },
);

server.registerTool(
  'url_params',
  {
    title: 'URLパラメータの分解・編集・再構築',
    description:
      'URLのクエリ文字列をキーと値へ分解し、編集・追加・削除・並べ替えをして再構築する' +
      '（tools.first-ch.com/url/ と同一ロジック）。UTMタグの付与、gclid等のクリックIDの一括削除、' +
      '文字列単体のURLエンコード/デコード（mode="encode" / "decode"）もできる。' +
      'リダイレクトURLやAPI引数の中身の確認、計測用URLの作成、共有前のクエリの掃除に使う。' +
      '値はデコードして返し（%XX を元の文字へ、+ を半角スペースへ）、編集していないパラメータは' +
      '生の文字列のまま書き戻すため、何も指定しなければ再構築後のURLは入力と1バイトも変わらない' +
      '（署名付きURLを通しても壊れない）。reencode=true で全体を encodeURIComponent の規則へ正規化する。' +
      '重複キー・未エンコードのスペースや非ASCII・壊れた %XX・+ のスペース解釈・UTM値の大文字混在や' +
      'source/mediumの片落ち・URL内のパスワード・トークンらしきキー・2000文字超を warnings で知らせる。' +
      '相対パスや壊れたパーセントエンコードでも例外にせず、読める範囲まで分解する。' +
      '完全ローカル処理・ネットワーク送信なし（URLへのアクセスは行わない）。',
    inputSchema: {
      url: z.string().optional().describe('mode="parse": 分解するURL（相対パス・部分的なURLも可）'),
      mode: z
        .enum(['parse', 'encode', 'decode'])
        .optional()
        .describe('既定 parse。encode/decode は url ではなく text を対象にする'),
      text: z.string().optional().describe('mode="encode"/"decode": 対象の文字列'),
      scheme: z
        .enum(['component', 'uri', 'form'])
        .optional()
        .describe('encode/decode の方式（既定 component=encodeURIComponent / uri=encodeURI / form=スペースを +）'),
      set: z.record(z.string()).optional().describe('parse: 追加・上書きするパラメータ（値が空文字なら削除）'),
      remove: z.array(z.string()).optional().describe('parse: 削除するパラメータ名（大文字小文字を無視）'),
      utm: z
        .record(z.string())
        .optional()
        .describe('parse: UTMタグ。source / medium / campaign / content / term / id（utm_ 付きでも可）'),
      removeTracking: z.boolean().optional().describe('parse: gclid・fbclid 等のクリックIDを一括削除する'),
      sort: z.boolean().optional().describe('parse: パラメータを名前順に並べ替える'),
      reencode: z.boolean().optional().describe('parse: 全パラメータを encodeURIComponent の規則で書き直す'),
      spaceAsPlus: z.boolean().optional().describe('parse: 新たにエンコードする値のスペースを %20 ではなく + にする'),
    },
  },
  async (opts) => {
    await logUsage('url_params');
    return asText(urlParams(opts));
  },
);

server.registerTool(
  'html_escape',
  {
    title: 'HTML特殊文字のエスケープ・エンティティのデコード',
    description:
      'テキスト中の < > & " \' をHTMLエンティティへ変換し、逆に &amp; &#39; &#x3042; などの文字参照を' +
      '元の文字へ戻す（tools.first-ch.com/html-escape/ と同一ロジック）。' +
      '記事やコード例へHTMLをそのまま載せる、テンプレートへ差し込む値を安全にする、' +
      'スクレイピングやAPIで受け取ったエンティティ混じりのテキストを読める形に戻す、といった用途に使う。' +
      'エスケープは & を最初に処理するため何度実行しても二重エスケープにならず、' +
      '名前付き参照と数値文字参照（10進・16進）を切り替えられる。' +
      'デコードはHTML 4.01の名前付き文字参照252個すべてと10進/16進に対応し、' +
      '知らない名前や範囲外の数値は推測で変換せずそのまま残して notes で知らせる。' +
      '&#128; のようなC1領域の数値参照はHTML仕様どおり Windows-1252 の文字（€）へ読み替える。' +
      'すでにエスケープ済みの入力・裸の &・セミコロンで閉じていない参照・ノーブレークスペース(U+00A0)の' +
      '混入も notes で指摘する。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      mode: z.enum(['escape', 'unescape']).optional().describe('既定 escape。unescape はエンティティを元の文字へ戻す'),
      text: z.string().optional().describe('対象のテキスト（path と排他）'),
      path: z.string().optional().describe('対象ファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('結果を書き出す絶対パス（指定すると text は返さない）'),
      quotes: z.boolean().optional().describe('escape: " と \' も変換するか（既定 true。属性値へ入れるなら必須）'),
      apos: z.boolean().optional().describe("escape: ' を &apos; にするか（既定 false=&#39;。&apos; はHTML 4.01に無い）"),
      numeric: z.boolean().optional().describe('escape: 名前ではなく数値文字参照（&#38; 形式）で出力するか（既定 false）'),
      nonAscii: z
        .enum(['none', 'named', 'decimal', 'hex'])
        .optional()
        .describe('escape: 非ASCII文字の扱い（既定 none。文字コードが伝わらない経路へ渡すなら decimal/hex）'),
    },
  },
  async (opts) => {
    await logUsage('html_escape');
    return asText(await htmlEscape(opts));
  },
);

// JSON ⇄ YAML は「入力の形式」ごとに別ツールにしている（direction を間違えると
// 何も変換されないまま返ってしまうため、名前で向きが決まる方が誤用しにくい）。
const JSON_YAML_SHARED =
  '変換は完全ローカル処理・ネットワーク送信なし。text か path のどちらか一方を渡す。' +
  'outputPath を渡すとファイルへ書き出す（本文は返さない）。' +
  '構文エラーのときは「何行何桁・原因・直し方」と、その前後2行の抜き出しをエラーとして返すので、' +
  '設定ファイルの構文チェックにも使える。' +
  '読み替えで意味が変わる箇所は notes で知らせる（キーの重複＝後が勝つ・2の53乗を超える整数の桁落ちなど）。';

server.registerTool(
  'json_to_yaml',
  {
    title: 'JSON → YAML 変換・整形',
    description:
      'JSONをYAMLへ変換して整形する（tools.first-ch.com/json-yaml/ と同一ロジック）。' +
      'APIレスポンスやテンプレートの出力を docker-compose・GitHub Actions・Kubernetes マニフェストのような' +
      '設定ファイルへ写すときに使う。インデント幅・引用符の付け方・null の書き方・複数行文字列を' +
      'ブロックスカラー（|）で書くか・キーを名前順に並べるか・先頭に --- を付けるかを選べる。' +
      '別の型に読まれうる文字列（yes / no / on / off / 0755 / 12:30 / 2026-08-12 / 数値に見える文字列）、' +
      '前後に空白がある文字列、- や * や # で始まる文字列は自動で引用符を付けるので、' +
      'YAML 1.1 のパーサ（PyYAMLなど）に渡しても意味が変わらない。' +
      '改行を含む文字列は | のブロック表記にし、行末の空白など復元できない形のときだけ "…" に倒す。' +
      'コメント・末尾カンマ・シングルクォート・引用符なしのキーを含むJSON（tsconfig.json など）も' +
      '読み取って変換し、JSONとしては不正であることを notes で知らせる（relaxed=false で厳密に拒否できる）。' +
      JSON_YAML_SHARED,
    inputSchema: {
      text: z.string().optional().describe('変換するJSON（path と排他）'),
      path: z.string().optional().describe('変換するJSONファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('YAMLを書き出す絶対パス（指定すると text は返さない）'),
      indent: z.number().int().min(1).max(8).optional().describe('YAMLのインデント幅（既定2）'),
      quote: z
        .enum(['auto', 'single', 'double'])
        .optional()
        .describe("引用符の付け方（既定 auto=必要なときだけ / single='…' / double=\"…\"）"),
      nullStyle: z.enum(['null', 'tilde', 'empty']).optional().describe('null の書き方（既定 null / tilde=~ / empty=空欄）'),
      block: z.boolean().optional().describe('改行を含む文字列を | のブロック表記で書くか（既定 true）'),
      sortKeys: z.boolean().optional().describe('キーを名前順に並べるか（既定 false=入力の順）'),
      docStart: z.boolean().optional().describe('先頭に --- を付けるか（既定 false）'),
      relaxed: z.boolean().optional().describe('コメント・末尾カンマ等を含むJSONも読むか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('json_to_yaml');
    return asText(await jsonToYaml(opts));
  },
);

server.registerTool(
  'yaml_to_json',
  {
    title: 'YAML → JSON 変換・構文チェック',
    description:
      'YAMLをJSONへ変換する（tools.first-ch.com/json-yaml/ と同一ロジック）。' +
      'docker-compose・GitHub Actions・Kubernetes マニフェスト・CIの設定を、プログラムから扱える形へ' +
      '読み替えるときや、構文の妥当性を確かめるときに使う。インデント2/4/タブ/1行（indent=0）を選べ、' +
      'キーの並べ替えと非ASCII文字の \\uXXXX 化もできる。' +
      '複数ドキュメント（--- 区切り）はJSONの配列1つにまとめ、アンカー &名前 / エイリアス *名前 /' +
      'マージキー << は展開する（JSONに参照の仕組みが無いため。展開したことは notes で知らせる）。' +
      'スカラーの解釈は YAML 1.2 core schema に従うので yes / no / on / off / NO は文字列のままだが、' +
      'YAML 1.1 のパーサでは真偽値になる値、0755（10進の755になる）、12:30（60進数の750になる）、' +
      '日付に見える値は notes で知らせる。' +
      '対応: ブロックマップ/シーケンス・フロー表記 [] {}・引用スカラー（複数行・エスケープ）・' +
      'ブロックスカラー | > と chomping - + と明示インデント・タグ（!!str !!int !!float !!bool !!null !!binary）・コメント。' +
      '未対応は「? キー」の明示キー記法のみ。' +
      JSON_YAML_SHARED,
    inputSchema: {
      text: z.string().optional().describe('変換するYAML（path と排他）'),
      path: z.string().optional().describe('変換するYAMLファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('JSONを書き出す絶対パス（指定すると text は返さない）'),
      indent: z
        .union([z.number().int().min(0).max(8), z.literal('tab')])
        .optional()
        .describe('JSONのインデント（既定2 / 0=改行なしの1行 / "tab"=タブ）'),
      sortKeys: z.boolean().optional().describe('キーを名前順に並べるか（既定 false=入力の順）'),
      ascii: z.boolean().optional().describe('非ASCII文字を \\uXXXX へエスケープするか（既定 false）'),
    },
  },
  async (opts) => {
    await logUsage('yaml_to_json');
    return asText(await yamlToJson(opts));
  },
);

server.registerTool(
  'px_rem_convert',
  {
    title: 'px ⇄ rem / em 単位換算・CSSの一括変換',
    description:
      'CSSの長さの単位を px ⇄ rem / em / pt で換算する（tools.first-ch.com/px-rem/ と同一ロジック）。' +
      'value を渡すと1つの値の換算になり、px・rem・em・pt の値と、そのまま貼れる font-size の1行、' +
      'よく使うフォントサイズ（12〜64px）のスケール表を返す。' +
      'css か path を渡すとCSS全体の一括変換になり、px→rem（px2rem）のほか px2em / rem2px / em2px を選べる。' +
      'デザインカンプのpx指定をremへ直す、既存のスタイルシートをアクセシビリティのためにrem化する、' +
      'rem表記のCSSを実寸で確かめる、といった用途に使う。' +
      '一括変換ではコメント・文字列（content: "10px"）・url() の中身と、--size-16px のように' +
      '識別子の一部になっている数字は書き換えない。既定では minPx=2 で1pxの罫線を残し（remにすると' +
      '環境によって太さがばらつくため）、@media などアットルールの条件（ブレークポイント）も変換しない。' +
      'ルートは 62.5% のようなパーセントでも指定でき、その場合はブラウザ既定16pxに対する割合として読む。' +
      '割り切れない値は丸めたことを notes で知らせる。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      value: z
        .union([z.number(), z.string()])
        .optional()
        .describe('換算する1つの値（24 / "24px" / "1.5rem" のように単位を含めてもよい。css / path と排他）'),
      unit: z
        .enum(['px', 'rem', 'em', 'pt', '%'])
        .optional()
        .describe('value の単位（既定 px。value に単位を書いた場合はそちらが優先）'),
      css: z.string().optional().describe('一括変換するCSS（value / path と排他）'),
      path: z.string().optional().describe('一括変換するCSSファイルの絶対パス（UTF-8として読む。value / css と排他）'),
      outputPath: z.string().optional().describe('変換後のCSSを書き出す絶対パス（指定すると本文は返さない）'),
      direction: z
        .enum(['px2rem', 'px2em', 'rem2px', 'em2px'])
        .optional()
        .describe('一括変換の向き（既定 px2rem）'),
      root: z
        .union([z.number(), z.string()])
        .optional()
        .describe('ルート（html要素）のフォントサイズ px（既定16。"62.5%" のような指定も可）'),
      parent: z
        .union([z.number(), z.string()])
        .optional()
        .describe('親要素のフォントサイズ px（em の基準。既定は root と同じ）'),
      precision: z
        .union([z.number().int().min(0).max(6), z.literal('auto')])
        .optional()
        .describe('小数の桁（既定 auto=6桁まで見て末尾の0を落とす。数値を渡すとその桁で固定）'),
      minPx: z
        .number()
        .optional()
        .describe('一括変換で、換算後の絶対値がこの px 未満の値は変換しない（既定2＝1pxの罫線を残す。0で全部変換）'),
      zeroUnitless: z.boolean().optional().describe('0 を単位なしの 0 にするか（既定 true）'),
      skipMedia: z.boolean().optional().describe('@media などアットルールの条件を変換対象から外すか（既定 true）'),
      ignoreProps: z
        .array(z.string())
        .optional()
        .describe('変換しないプロパティ（前方一致。例 ["border","outline","box-shadow"]）'),
      scale: z.boolean().optional().describe('値の換算のときに12〜64pxのスケール表を返すか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('px_rem_convert');
    return asText(await pxRemConvert(opts));
  },
);

server.registerTool(
  'color_convert',
  {
    title: 'カラーコード変換・アルファ透過計算',
    description:
      '色のコードを HEX / RGB / HSL / OKLCH で相互変換し、アルファ（透過度）付きの rgba() / hsla() / 8桁HEX を返す' +
      '（tools.first-ch.com/color/ と同一ロジック）。' +
      '入力は HEX（3/4/6/8桁）・rgb()・hsl()・hwb()・oklch()・oklab()・CSSの名前付き色（148色）・transparent を受け付け、' +
      '旧記法のカンマ区切りと新記法のスラッシュ区切り、角度の単位（deg / grad / rad / turn）も読む。' +
      'background を渡すと、透過色をその背景の上に重ねたときに実際に見える色（アルファ合成の結果）を flattened で返すので、' +
      'デザインカンプの半透明レイヤーを不透明なHEXへ置き換える用途に使える。' +
      'あわせて白文字・黒文字とのWCAG 2.1コントラスト比、アルファを刻んだ表（alpha_table）、' +
      '色相と彩度を保ったまま明度だけを50〜950の11段に振った明度パレット（palette）を返す。' +
      'sRGBで表現できないOKLCHは、RGBを切り詰めると色相がずれるため、明度と色相を保ったまま彩度だけを下げて収める。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      color: z
        .string()
        .describe('変換する色（"#c8501f" / "rgb(200 80 31)" / "hsl(17 73% 45%)" / "oklch(56% 0.16 41)" / "tomato" など）'),
      alpha: z
        .union([z.number(), z.string()])
        .optional()
        .describe('アルファ（0〜1・0〜100・"50%" のいずれか。指定すると color 側のアルファを上書きする）'),
      background: z
        .string()
        .optional()
        .describe('重ねる背景色（既定 #ffffff）。flattened と alpha_table の合成結果に使う'),
      syntax: z
        .enum(['modern', 'legacy'])
        .optional()
        .describe('rgb(200 80 31 / 50%) のモダン記法（既定）か、rgba(200, 80, 31, 0.5) の従来記法か'),
      uppercase: z.boolean().optional().describe('HEXを大文字で書き出すか（既定 false）'),
      alphaPercent: z.boolean().optional().describe('アルファをパーセントで書くか（既定 false＝0〜1）'),
      step: z.number().optional().describe('alpha_table の刻み（%・1〜50。既定10）'),
      alphaTable: z.boolean().optional().describe('アルファを刻んだ表を返すか（既定 true）'),
      palette: z.boolean().optional().describe('明度パレット（50〜950の11段）を返すか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('color_convert');
    return asText(colorConvert(opts));
  },
);

server.registerTool(
  'hash_generate',
  {
    title: 'MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 ハッシュ生成・照合',
    description:
      'テキストまたはファイルの MD5・SHA-1・SHA-256・SHA-384・SHA-512 ハッシュ値を一度に算出する' +
      '（tools.first-ch.com/hash/ と同一の仕様）。' +
      'ダウンロードしたファイルが配布元のチェックサムと一致するかの確認、変更の検出、' +
      'APIリクエストの署名計算の下ごしらえ、キャッシュキーの生成といった用途に使う。' +
      'expected に期待値を渡すと桁数から対象のアルゴリズムを判定して照合し、一致したかどうかを返す。' +
      'expected は `sha256sum` の出力（`<ハッシュ値>␣␣<ファイル名>`）・`SHA256 (file) = …`・' +
      '`sha256:` のような接頭辞付き・コロン区切りの16進・Base64 をそのまま渡せる。' +
      '出力は16進の小文字/大文字・Base64・base64url を選べる。' +
      'text は改行コード（lf / crlf）とUTF-8のBOMの有無を指定できるので、Windowsで作られたファイルの' +
      '値も再現できる（文字コードはUTF-8固定）。ファイルは大きくてもストリームで1パス処理する。' +
      'MD5とSHA-1は衝突耐性が破られており署名・改ざん検知には使えないこと、ハッシュ値をそのまま' +
      'パスワード保存に使ってはいけないこと（ソルト付きのbcrypt / scrypt / Argon2を使う）は notes で知らせる。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      text: z.string().optional().describe('ハッシュ値を計算するテキスト（path と排他）'),
      path: z.string().optional().describe('ハッシュ値を計算するファイルの絶対パス（text と排他）'),
      algorithms: z
        .array(z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']))
        .optional()
        .describe('算出するアルゴリズム（既定 ["md5","sha1","sha256","sha512"]）'),
      format: z
        .enum(['hex', 'HEX', 'base64', 'base64url'])
        .optional()
        .describe('出力の書式（既定 hex=16進の小文字 / HEX=16進の大文字 / base64 / base64url）'),
      newline: z
        .enum(['lf', 'crlf'])
        .optional()
        .describe('text の改行コード（既定 lf。Windowsのファイルと突き合わせるなら crlf。path には影響しない）'),
      bom: z.boolean().optional().describe('text の先頭にUTF-8のBOMを付けるか（既定 false。path には影響しない）'),
      expected: z.string().optional().describe('照合するハッシュ値（コマンドの出力をそのまま渡してよい）'),
    },
  },
  async (opts) => {
    await logUsage('hash_generate');
    return asText(await hashGenerate(opts));
  },
);

await server.connect(new StdioServerTransport());
