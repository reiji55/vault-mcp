// MCP サーバー本体。どのツールも Vault（VAULT_ROOT）の中だけを触る。
//
// 書き込みは必ず「版（rev）を確かめてから」。iPad の Obsidian などほかの端末が
// 先に書き換えていたら、黙って上書きせずに競合として止める。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeDropbox } from './dropbox.js';
import { vaultRoot, toDropbox, toRel, isHidden } from './paths.js';
import { applyEdits, appendText } from './edit.js';

const ok = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const ng = err => ({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });
const safe = fn => async args => { try { return await fn(args); } catch (e) { return ng(e); } };

const PATH = z.string().describe('Vault 内の相対パス。例 "wiki/cases/foo.md"、"CLAUDE.md"');
const REV = z.string().describe('vault_read / vault_list が返した rev（ファイルの版）');

export function createServer(dbx = makeDropbox()) {
  const root = vaultRoot();
  const rel = abs => toRel(abs, root);

  const server = new McpServer(
    { name: 'vault', version: '1.0.0' },
    {
      instructions:
        `Obsidian の Vault（Dropbox の ${root}。remotely-save で各端末と同期）の中身を読み書きする。` +
        'パスは Vault 内の相対パス（例 "wiki/cases/foo.md"）。' +
        '既存ファイルの一部を直すなら vault_edit（変更箇所だけ送ればよく、全文を作り直さない）、' +
        '末尾に足すなら vault_append、新規作成と丸ごとの書き換えは vault_write。' +
        '丸ごと書き換えるときは vault_read か vault_list で rev を取ってから渡す。' +
        'ほかの端末が先に書き換えていたら競合で止まるので、読み直してからやり直す。' +
        '削除・移動・名前の変更はこのコネクタには無い（Dropbox コネクタを使う）。'
    }
  );

  server.registerTool('vault_list', {
    title: 'フォルダの中身を見る',
    description:
      'フォルダの中のファイルとフォルダを返す。1行1件で「パス／更新日時(UTC)／サイズ／rev」。フォルダは末尾が "/"。' +
      '.obsidian などドットで始まるものは既定で省く。rev はそのまま vault_write に渡せる。',
    inputSchema: {
      path: z.string().optional().describe('見るフォルダ。省略か "" で Vault 直下'),
      recursive: z.boolean().optional().describe('true で下の階層まで全部。既定 false'),
      include_hidden: z.boolean().optional().describe('true で .obsidian などドットで始まるものも出す')
    },
    annotations: { readOnlyHint: true }
  }, safe(async ({ path = '', recursive = false, include_hidden = false }) => {
    const abs = toDropbox(path, root, { allowRoot: true });
    const base = rel(abs);
    const showHidden = include_hidden || isHidden(base);
    const { entries, truncated } = await dbx.list(abs, { recursive });
    const rows = entries
      .map(e => ({ path: rel(e.path_display), folder: e['.tag'] === 'folder', e }))
      .filter(r => r.path && r.path !== base && (showHidden || !isHidden(r.path)))
      .sort((a, b) => a.path.localeCompare(b.path));
    const files = rows.filter(r => !r.folder).length;
    const lines = rows.map(r => r.folder
      ? `${r.path}/`
      : `${r.path}\t${r.e.server_modified}\t${r.e.size}\t${r.e.rev}`);
    const head = `# ${base || '(Vault 直下)'}  ファイル ${files} / フォルダ ${rows.length - files}` +
      (truncated ? '（多すぎるので途中まで）' : '');
    return ok([head, 'path\tmodified(UTC)\tsize\trev', ...lines].join('\n'));
  }));

  server.registerTool('vault_read', {
    title: 'ファイルを読む',
    description:
      'ファイルの本文と rev（版）を返す。複数読むときは配列でまとめて渡す（最大10件）。' +
      'rev は vault_write で丸ごと書き換えるときに要る。',
    inputSchema: {
      path: z.union([PATH, z.array(PATH).min(1).max(10)]).describe('相対パス。複数なら配列')
    },
    annotations: { readOnlyHint: true }
  }, safe(async ({ path }) => {
    const paths = Array.isArray(path) ? path : [path];
    const blocks = [];
    let failed = 0;
    for (const p of paths) {
      try {
        const f = await dbx.download(toDropbox(p, root));
        if (f.text.includes('\u0000')) throw new Error('テキストではなさそうです（画像などのバイナリ）');
        blocks.push({ type: 'text', text: `--- ${rel(f.path_display)}  rev=${f.rev}  ${f.size} bytes  更新 ${f.modified} ---` });
        blocks.push({ type: 'text', text: f.text });
      } catch (e) {
        failed++;
        blocks.push({ type: 'text', text: `--- ${p}: 読めませんでした: ${e.message} ---` });
      }
    }
    return failed === paths.length ? { isError: true, content: blocks } : { content: blocks };
  }));

  server.registerTool('vault_write', {
    title: 'ファイルを作る／丸ごと書き換える',
    description:
      'rev を渡さなければ新規作成（同じ名前があれば止まる）。rev を渡すとその版を丸ごと置き換える' +
      '（その後に誰かが書き換えていたら止まる）。途中のフォルダは自動で作られる。' +
      '一部だけ直すなら vault_edit、末尾に足すなら vault_append の方が速くて安全。',
    inputSchema: {
      path: PATH,
      content: z.string().describe('ファイルの中身（全文）'),
      rev: REV.optional()
    },
    annotations: { destructiveHint: true }
  }, safe(async ({ path, content, rev }) => {
    const abs = toDropbox(path, root);
    try {
      const r = await dbx.upload(abs, content, { rev });
      return ok({ path: rel(r.path_display), rev: r.rev, size: r.size, mode: rev ? '上書き' : '新規' });
    } catch (e) {
      if (e.kind !== 'conflict') throw e;
      if (!rev) {
        throw new Error(`${rel(abs)} は既にあります。丸ごと書き換えるなら vault_read か vault_list で rev を取って渡してください` +
          '（一部だけ直すなら vault_edit）');
      }
      throw new Error(`${rel(abs)} は rev ${rev} のあとに別の場所で更新されています。vault_read で読み直してから書いてください`);
    }
  }));

  server.registerTool('vault_edit', {
    title: 'ファイルの一部を直す',
    description:
      'old_str を new_str に置き換える。old_str はファイル中で1箇所だけ当たること' +
      '（足りなければ前後の文を足す。全部置き換えるなら replace_all: true）。new_str を "" にすると消せる。' +
      '何箇所か直すときは edits に並べると1回で保存できる（上から順に当て、1つでも外れたら何も保存しない）。' +
      'rev は省略可。渡すと、その版から変わっていた場合に止まる。',
    inputSchema: {
      path: PATH,
      old_str: z.string().optional().describe('置き換える元の文。一字一句同じに'),
      new_str: z.string().optional().describe('置き換え後の文。省略か "" で削除'),
      replace_all: z.boolean().optional().describe('true で当たった箇所を全部置き換える'),
      edits: z.array(z.object({
        old_str: z.string(),
        new_str: z.string().optional(),
        replace_all: z.boolean().optional()
      })).min(1).max(50).optional().describe('複数の置き換え。old_str/new_str とどちらか一方だけ使う'),
      rev: REV.optional()
    },
    annotations: { destructiveHint: true }
  }, safe(async ({ path, old_str, new_str, replace_all, edits, rev }) => {
    if (edits && old_str !== undefined) throw new Error('old_str/new_str と edits は、どちらか一方だけ渡してください');
    const list = edits || (old_str !== undefined ? [{ old_str, new_str, replace_all }] : null);
    if (!list) throw new Error('old_str と new_str（または edits）を渡してください');

    const abs = toDropbox(path, root);
    const cur = await dbx.download(abs);
    if (rev && rev !== cur.rev) {
      throw new Error(`${rel(abs)} は rev ${rev} のあとに更新されています（今は ${cur.rev}）。vault_read で読み直してください`);
    }
    const { text, replaced } = applyEdits(cur.text, list);
    if (text === cur.text) return ok({ path: rel(abs), rev: cur.rev, changed: false, note: '変更ありません' });
    try {
      const r = await dbx.upload(abs, text, { rev: cur.rev });
      return ok({ path: rel(r.path_display), rev: r.rev, size: r.size, replaced, changed: true });
    } catch (e) {
      if (e.kind === 'conflict') throw new Error(`${rel(abs)} が保存の直前に別の場所で更新されました。もう一度やり直してください`);
      throw e;
    }
  }));

  server.registerTool('vault_append', {
    title: 'ファイルの末尾に足す',
    description:
      '末尾に改行を挟んで足す。ファイルが無ければ作る。日報やログに1行足すときに使う。' +
      '全文を読み直す必要はない。',
    inputSchema: {
      path: PATH,
      content: z.string().min(1).describe('足す文')
    },
    annotations: { destructiveHint: false }
  }, safe(async ({ path, content }) => {
    const abs = toDropbox(path, root);
    for (let attempt = 0; ; attempt++) {
      let cur = null;
      try { cur = await dbx.download(abs); } catch (e) { if (e.kind !== 'not_found') throw e; }
      try {
        const r = await dbx.upload(abs, appendText(cur?.text || '', content), { rev: cur?.rev });
        return ok({ path: rel(r.path_display), rev: r.rev, size: r.size, created: !cur });
      } catch (e) {
        // 足すだけなので、間に誰かが書いていても読み直して1回だけやり直せば安全
        if (e.kind === 'conflict' && attempt === 0) continue;
        throw e;
      }
    }
  }));

  server.registerTool('vault_search', {
    title: 'ファイルを探す',
    description:
      'Dropbox の検索で Vault の中を探す。返るのはパスと当たり方（filename / content）。' +
      '本文まで探せるのは Dropbox の有料プランだけで、無料プランだとファイル名にしか当たらない。' +
      '書いたばかりのファイルは索引に載るまで少しかかる。',
    inputSchema: {
      query: z.string().min(1).describe('探す語'),
      path: z.string().optional().describe('この下だけ探す。省略で Vault 全体'),
      max_results: z.number().int().min(1).max(100).optional().describe('既定 20')
    },
    annotations: { readOnlyHint: true }
  }, safe(async ({ query, path = '', max_results = 20 }) => {
    const abs = toDropbox(path, root, { allowRoot: true });
    const { hits, has_more } = await dbx.search(query, abs, { max: max_results });
    const lines = hits
      .map(h => ({ path: rel(h.meta.path_display), folder: h.meta['.tag'] === 'folder', match: h.match }))
      .filter(h => !isHidden(h.path))
      .map(h => `${h.path}${h.folder ? '/' : ''}\t${h.match}`);
    if (!lines.length) return ok(`「${query}」に当たるものはありませんでした`);
    return ok([`# 「${query}」 ${lines.length}件${has_more ? '（ほかにもあり）' : ''}`, ...lines].join('\n'));
  }));

  return server;
}
