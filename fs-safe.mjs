// 出力ファイルの書き込み（MCPツール共通）
//
// 既定では既存ファイルを上書きしない（'wx' フラグ＝存在したら失敗）。
// AIが確認なしに利用者のファイルを消すのを防ぐため。上書きしたいときは
// 呼び出し側が overwrite: true を明示する（各ツールの inputSchema に overwrite がある）。

import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class OutputExistsError extends Error {
  constructor(file) {
    super(`出力先に同名のファイルが既にあります: ${file}（上書きする場合は overwrite: true を渡してください）`);
    this.code = 'EEXIST';
    this.file = file;
  }
}

export async function writeOutput(file, data, { overwrite = false } = {}) {
  try {
    await writeFile(file, data, { flag: overwrite ? 'w' : 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') throw new OutputExistsError(file);
    throw e;
  }
}

// 出力先を指定しなかったときの置き場（OSの一時ディレクトリの下の専用フォルダ）。
// ここへ書いたファイルは利用者が開くための成果物なので、サーバーは消さない。
// 置き場所を1か所に寄せて、まとめて消せるようにしている。
export async function defaultOutputDir() {
  const dir = path.join(os.tmpdir(), 'firstch-tools-mcp');
  await mkdir(dir, { recursive: true });
  return dir;
}
