/* MCP の prompts（作業の手順書）
 * よくある作業を「どのツールをどの順で呼び、何をまとめるか」の手順として、クライアントの
 * プロンプト一覧（スラッシュコマンド等）から呼べるようにする。プロンプトはツールを実行しない。
 * 手順の文面をモデルに渡すだけで、実際に呼ぶかどうかはクライアントとモデルが決める。
 *
 * requires に挙げたツールがすべて登録されているときだけ、そのプロンプトを登録する
 * （FIRSTCH_TOOLSETS で絞ったときや、app_* が無効なときに、呼べないツールを案内しないため）。
 * 引数は MCP の仕様どおりすべて文字列で受ける。 */
import { z } from 'zod';

const text = (s) => ({ messages: [{ role: 'user', content: { type: 'text', text: s } }] });

export const PROMPTS = [
  {
    name: 'prelaunch_site_check',
    title: '公開前のサイト点検（URL）',
    description:
      '公開直前・公開直後のページのURLを、apps.first-ch.com の点検ツール（app_*）で順に調べ、直す順に並べた一覧にまとめる手順。' +
      'URL は apps.first-ch.com へ送られる（FIRSTCH_ENABLE_APPS=1 のときだけ出る）。',
    requires: [
      'app_meta_check', 'app_headers', 'app_ssl', 'app_redirect_trace', 'app_link_check',
      'app_ogp_check', 'app_structured_data', 'app_ai_access', 'app_notice_check',
    ],
    argsSchema: {
      url: z.string().describe('点検するページのURL（https://〜）'),
    },
    build: ({ url }) =>
      text(
        [
          `次のページを公開前に点検してください: ${url}`,
          '',
          'この URL は apps.first-ch.com へ送られます。社外秘のページや、認証の要るページなら、ここで止めて確認してください。',
          '',
          '手順（app_ssl 以外には url をそのまま渡す。1つが失敗しても残りは続ける）:',
          '1. app_redirect_trace — 最終的な URL と、http→https・www の有無の転送が1回で済んでいるか',
          '2. app_ssl — 証明書の期限と、名前の一致（host には URL のホスト名だけを渡す）',
          '3. app_headers — セキュリティヘッダーの採点',
          '4. app_meta_check — title・description・canonical・robots（noindex の消し忘れ）',
          '5. app_ogp_check — SNS で共有したときの画像・タイトル',
          '6. app_structured_data — JSON-LD の有無と誤り',
          '7. app_link_check — リンク切れと画像の alt',
          '8. app_ai_access — AI クローラーの許可・拒否が意図どおりか',
          '9. app_notice_check — ダミーテキスト・仮の文字・消し忘れ',
          '',
          'まとめ方:',
          '- 「公開前に必ず直す」「直したほうがよい」「問題なし」の3段に分け、各項目に根拠（どのツールの、どの値か）を添える',
          '- ツールの結果に無いことは推測で書かない。調べられなかった項目は「未確認」として残す',
          '- 最後に、直したあとで再点検に使うツール名を並べる',
        ].join('\n'),
      ),
  },
  {
    name: 'image_before_publish',
    title: '画像を公開・送付する前の点検',
    description:
      '画像ファイルを公開・送付する前に、終端より後ろに残ったデータ（kuronuri_tail）と ComfyUI の埋め込みデータに残った API キーの形（comfy_png_leak_scan）を調べ、' +
      '問題が無ければ WebP に変換する（webp_convert）手順。すべて端末内で処理する。',
    requires: ['kuronuri_tail', 'comfy_png_leak_scan', 'webp_convert'],
    argsSchema: {
      path: z.string().describe('点検する画像ファイル（PNG / JPEG）の絶対パス'),
    },
    build: ({ path }) =>
      text(
        [
          `次の画像を、公開・送付する前に点検してください: ${path}`,
          '',
          '手順:',
          '1. kuronuri_tail に path を渡し、画像の終わり（PNG の IEND・JPEG の EOI）より後ろにデータが付いていないかを見る。',
          '   付いていれば、元の画像やトリミング前の部分が残っている可能性がある。バイト数を示し、送らずに作り直すよう伝える。',
          '2. PNG なら comfy_png_leak_scan に path を渡し、埋め込みデータに API キーの形が残っていないかを見る。',
          '   見つかったら、値は表示せず、ノードIDと入力欄の場所だけを示す。キーの持ち主にはキーの無効化と再発行を勧める。',
          '   文字のチャンクを抜いたコピーが要るなら outPath を指定して作れることを伝える（元の画像は書き換えない）。',
          '3. 1・2 とも問題が無いときだけ、webp_convert で WebP に変換する（既定の品質80。既存のファイルは上書きしない）。',
          '   問題があるときは変換しない。',
          '',
          'まとめ: 点検の結果（問題なし / 要対応）と、変換した場合は出力先とサイズの変化を短く報告する。',
        ].join('\n'),
      ),
  },
  {
    name: 'reply_before_send',
    title: 'AI が書いた返信案を送る前の照合',
    description:
      'AI が書いた返信案を、届いたメールと照合し（reply_check）、原文に無い日付・曜日・時刻・金額・数量・電話・宛名と、消し忘れの仮の文字を直してから送るための手順。端末内で処理する。',
    requires: ['reply_check'],
    argsSchema: {
      reply: z.string().describe('AI が書いた返信案'),
      received: z.string().optional().describe('届いたメール（返信の元になった原文）'),
      facts: z.string().optional().describe('自分で決めた事実（営業時間・料金・日程など。任意）'),
    },
    build: ({ reply, received, facts }) =>
      text(
        [
          '次の返信案を、送る前に reply_check で照合してください。',
          '',
          '手順:',
          '1. reply_check に reply・received・facts をそのまま渡す（下に貼ったもの。空の項目は渡さない）。',
          '2. 赤（原文にも事実にも無い日付・曜日・時刻・金額・数量・電話・宛名）は、1件ずつ原文の該当箇所と並べて示す。',
          '3. 黄（消し忘れの仮の文字）は、どこに残っているかを示す。',
          '4. 直した返信案を1つ示す。直したのは赤と黄の箇所だけにし、文面のほかの部分は変えない。',
          '   原文から正しい値が決められない箇所は、推測で埋めずに「要確認」と書いて残す。',
          '5. 送信はしない。送るかどうかは利用者が決める。',
          '',
          '--- reply（返信案） ---',
          reply,
          '--- received（届いたメール） ---',
          received || '（なし）',
          '--- facts（自分で決めた事実） ---',
          facts || '（なし）',
        ].join('\n'),
      ),
  },
  {
    name: 'ja_copy_check',
    title: '日本語の文面の点検（文字数・全角半角）',
    description:
      '日本語の文面（SNS 投稿・見出し・フォームの入力など）を、文字数と X のウェイト（count_chars）、全角・半角の混在や見えない文字（zenkaku_convert の inspect）で点検する手順。端末内で処理する。',
    requires: ['count_chars', 'zenkaku_convert'],
    argsSchema: {
      text: z.string().describe('点検する文面'),
      limit: z.string().optional().describe('文字数の上限（例: 140。任意）'),
    },
    build: ({ text: body, limit }) =>
      text(
        [
          '次の文面を点検してください。',
          '',
          '手順:',
          '1. count_chars に text を渡し、文字数（書記素単位）・空白を除いた文字数・行数・X のウェイト（上限280）を見る。',
          limit
            ? `   上限は ${limit} 文字。超えていれば何文字超えているかを示す。`
            : '   上限の指定は無い。X に投稿する文面なら、ウェイトが280を超えていないかを見る。',
          '2. zenkaku_convert に text と inspect: true を渡し、全角・半角の混在、半角カナ、見えない文字（ゼロ幅・BOM・制御文字）、空白の混在を見る。',
          '3. 直す必要がある箇所だけを、元の文と直した文を並べて示す。表記の統一は、文面の中で多いほうに合わせる。',
          '   意味や言い回しは変えない（文字数を減らす提案は、別の案として分けて出す）。',
          '',
          '--- text ---',
          body,
        ].join('\n'),
      ),
  },
];

/**
 * 登録済みのツール名から、登録できるプロンプトを選ぶ。
 * @param {Set<string>} toolNames
 */
export function availablePrompts(toolNames) {
  return PROMPTS.filter((p) => p.requires.every((n) => toolNames.has(n)));
}
