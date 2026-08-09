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

await server.connect(new StdioServerTransport());
