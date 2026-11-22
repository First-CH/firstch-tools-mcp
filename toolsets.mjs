/* ツールセット（FIRSTCH_TOOLSETS）
 * AIクライアントに見せるツールの一覧を、カテゴリ単位で絞るための表と解釈。
 * 例: FIRSTCH_TOOLSETS=web,seo なら Web制作と SEO のツールだけを登録する。
 * 未設定（または空）なら端末内で完結するツールをすべて登録する（従来どおり）。
 *
 * - 端末内のツールは、どれか1つのカテゴリにだけ属する（test.mjs が server.mjs の登録と突き合わせる）
 * - apps（app_*）は入力を apps.first-ch.com へ送るツール。FIRSTCH_ENABLE_APPS=1 のときだけ登録し、
 *   ツールセットに apps を書いただけでは有効にならない（外部への通信は必ず明示的に有効にする）
 * - 知らない名前は標準エラーに警告して無視する。有効な名前が1つも無ければ絞り込まない */

/** カテゴリ → そのカテゴリのツール名（端末内のツールのみ。app_* は apps） */
export const TOOLSETS = {
  web: [
    'contrast_check', 'color_convert', 'px_rem_convert', 'aspect_ratio_calc', 'css_layout_generate',
    'html_escape', 'url_params', 'qr_generate', 'user_agent_parse',
  ],
  seo: [
    'jsonld_generate', 'faq_jsonld_generate', 'llmstxt_generate', 'robotstxt_generate', 'serp_check',
    'slug_generate', 'ai_vs_search',
  ],
  ja: [
    'count_chars', 'zenkaku_convert', 'wareki_convert', 'date_calc', 'fit_to_box', 'invoice_nebiki_check',
    'reply_check', 'email_read_aloud', 'renkyu_pair_plan', 'romaji_name_check',
  ],
  image: ['webp_convert', 'comfy_png_leak_scan', 'kuronuri_tail', 'dpi_calc'],
  doc: [
    'marp_render', 'html_to_markdown', 'markdown_table', 'openapi_doc_generate', 'wiki_doc_lint',
    'diff_check', 'lines_process', 'hidden_instruction_scan',
  ],
  dev: [
    'cron_explain', 'base64_encode', 'hash_generate', 'jwt_decode', 'uuid_generate', 'sql_format',
    'unixtime_convert', 'case_convert', 'cidr_calc', 'htpasswd_generate', 'encoding_convert',
  ],
  data: ['testdata_generate', 'json_to_yaml', 'yaml_to_json', 'csv_convert'],
  apps: [], // app_* はすべてここ（名前の頭で決める。FIRSTCH_ENABLE_APPS=1 が別に要る）
};

export const TOOLSET_NAMES = Object.keys(TOOLSETS);

/** ツール名からカテゴリを返す。どこにも無ければ null */
export function toolsetOf(name) {
  if (String(name).startsWith('app_')) return 'apps';
  for (const [set, names] of Object.entries(TOOLSETS)) {
    if (names.includes(name)) return set;
  }
  return null;
}

/**
 * FIRSTCH_TOOLSETS の値を読む。
 * @param {string|undefined} value カンマ区切り（空白・大文字小文字は問わない）
 * @returns {{ selected: Set<string>|null, unknown: string[] }} selected が null なら絞り込まない
 */
export function parseToolsets(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const selected = new Set();
  const unknown = [];
  for (const p of parts) {
    if (TOOLSET_NAMES.includes(p)) selected.add(p);
    else unknown.push(p);
  }
  return { selected: selected.size ? selected : null, unknown };
}

/**
 * ツールを登録するかどうか。
 * @param {string} name ツール名
 * @param {Set<string>|null} selected parseToolsets().selected
 */
export function isToolEnabled(name, selected) {
  const set = toolsetOf(name);
  if (set === null) return false;
  return selected === null || selected.has(set);
}
