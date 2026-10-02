// 本物の MCP クライアントを本物のプロトコルで喋らせて、
// 入口〜ツール〜Dropbox の読み書きまでを通しで確かめる。Dropbox だけ偽物に差し替える。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../lib/handler.js';
import { makeDropbox, resetTokenCache } from '../lib/dropbox.js';
import { fakeDropbox, ROOT } from './fake-dropbox.mjs';

const KEY = 'test-key-0123456789';
process.env.MCP_KEY = KEY;
delete process.env.VAULT_ROOT;

const CASE = `---
type: case
status: 進行中
---
# 浦和Chappy

- [ ] 監査を頼む
- [ ] 結果を記録
`;

function setup(env = { DROPBOX_APP_KEY: 'appkey123', DROPBOX_REFRESH_TOKEN: 'good-refresh' }) {
  resetTokenCache();
  const fake = fakeDropbox({
    [`${ROOT}/CLAUDE.md`]: '# Vault の憲法\n',
    [`${ROOT}/wiki/cases/浦和Chappy.md`]: CASE,
    [`${ROOT}/daily/2026-10-01.md`]: '# 10/1\n',
    [`${ROOT}/.obsidian/app.json`]: '{}',
    [`${ROOT}/raw/a.md`]: 'a', [`${ROOT}/raw/b.md`]: 'b', [`${ROOT}/raw/c.md`]: 'c'
  });
  const dbx = makeDropbox({ fetchImpl: fake.fetchImpl, env });
  return { fake, dbx };
}

async function connect(dbx, t, key = KEY) {
  const http = createHttp((req, res) => {
    const m = req.url.match(/^\/api\/mcp\/([^/?]+)/);
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (raw) { try { req.body = JSON.parse(raw); } catch { req.body = raw; } }
      handle(req, res, m ? decodeURIComponent(m[1]) : '', dbx);
    });
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${http.address().port}/api/mcp/${key}`);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  t.after(async () => { await client.close(); http.closeAllConnections(); await new Promise(r => http.close(r)); });
  return client;
}

const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content.map(c => c.text).join('\n'), json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};

test('ツールが6つ並ぶ', async t => {
  const { dbx } = setup();
  const client = await connect(dbx, t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(),
    ['vault_append', 'vault_edit', 'vault_list', 'vault_read', 'vault_search', 'vault_write']);
});

test('合鍵が違えば 404（存在を伏せる）', async () => {
  const { dbx } = setup();
  const res = await new Promise(resolve => {
    const http = createHttp((req, r) => handle(req, r, 'wrong-key-000000000', dbx));
    http.listen(0, '127.0.0.1', async () => {
      const out = await fetch(`http://127.0.0.1:${http.address().port}/api/mcp/x`, { method: 'POST', body: '{}' });
      http.close(); resolve(out);
    });
  });
  assert.equal(res.status, 404);
});

test('一覧：ドットで始まるものは省き、ページの続きも辿る', async t => {
  const { dbx } = setup();
  const client = await connect(dbx, t);
  const top = await call(client, 'vault_list', {});
  assert.ok(!top.isError, top.text);
  assert.match(top.text, /^CLAUDE\.md\t/m);
  assert.match(top.text, /^wiki\/$/m);
  assert.doesNotMatch(top.text, /\.obsidian/);

  const all = await call(client, 'vault_list', { recursive: true });   // 偽物は3件ずつ返す
  assert.match(all.text, /^wiki\/cases\/浦和Chappy\.md\t/m);
  assert.match(all.text, /^raw\/c\.md\t/m);
  assert.match(all.text, /ファイル 6/);

  const hidden = await call(client, 'vault_list', { path: '.obsidian' });
  assert.match(hidden.text, /\.obsidian\/app\.json/);
});

test('読む：本文と rev。複数まとめても読める', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_read', { path: 'wiki/cases/浦和Chappy.md' });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, new RegExp(`rev=${fake.rev('wiki/cases/浦和Chappy.md')}`));
  assert.equal(r.content[1].text, CASE);

  const many = await call(client, 'vault_read', { path: ['CLAUDE.md', 'nope.md'] });
  assert.ok(!many.isError, '片方でも読めれば失敗扱いにしない');
  assert.match(many.text, /# Vault の憲法/);
  assert.match(many.text, /nope\.md: 読めませんでした: 見つかりません/);

  // 本番の Dropbox は日本語のヘッダーを受け付けない。逃がしているか
  assert.ok(fake.calls.filter(c => c.arg).every(c => /^[\x20-\x7e]+$/.test(c.arg)));
});

test('一部を直す：変更箇所だけで保存され、ほかは残る', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_edit', {
    path: 'wiki/cases/浦和Chappy.md', old_str: 'status: 進行中', new_str: 'status: 様子見'
  });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.changed, true);
  assert.equal(fake.text('wiki/cases/浦和Chappy.md'), CASE.replace('進行中', '様子見'));
  assert.equal(r.json.rev, fake.rev('wiki/cases/浦和Chappy.md'));

  const two = await call(client, 'vault_edit', {
    path: 'wiki/cases/浦和Chappy.md',
    edits: [{ old_str: '- [ ] 監査を頼む', new_str: '- [x] 監査を頼む' }, { old_str: '- [ ] 結果を記録\n', new_str: '' }]
  });
  assert.ok(!two.isError, two.text);
  assert.match(fake.text('wiki/cases/浦和Chappy.md'), /- \[x\] 監査を頼む\n$/);
});

test('一部を直す：当たらない・複数当たる・古い rev は保存しない', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);
  const before = fake.text('wiki/cases/浦和Chappy.md');

  const miss = await call(client, 'vault_edit', { path: 'wiki/cases/浦和Chappy.md', old_str: 'ない文', new_str: 'x' });
  assert.ok(miss.isError); assert.match(miss.text, /見つかりません/);

  const dup = await call(client, 'vault_edit', { path: 'wiki/cases/浦和Chappy.md', old_str: '- [ ]', new_str: '- [x]' });
  assert.ok(dup.isError); assert.match(dup.text, /2 箇所/);

  const oldRev = fake.rev('wiki/cases/浦和Chappy.md');
  fake.touch('wiki/cases/浦和Chappy.md', before + 'iPad で足した行\n');   // ほかの端末が先に書いた
  const stale = await call(client, 'vault_edit', {
    path: 'wiki/cases/浦和Chappy.md', old_str: 'status: 進行中', new_str: 'status: 完了', rev: oldRev
  });
  assert.ok(stale.isError); assert.match(stale.text, /更新されています/);
  assert.equal(fake.text('wiki/cases/浦和Chappy.md'), before + 'iPad で足した行\n', 'iPad の変更が残る');

  const both = await call(client, 'vault_edit', { path: 'CLAUDE.md', old_str: 'a', edits: [{ old_str: 'b' }] });
  assert.ok(both.isError); assert.match(both.text, /どちらか一方/);
});

test('書く：新規は作る。既存は rev が要り、古い rev なら止まる', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);

  const created = await call(client, 'vault_write', { path: 'outputs/新しいメモ.md', content: '# 新規\n' });
  assert.ok(!created.isError, created.text);
  assert.equal(created.json.mode, '新規');
  assert.equal(fake.text('outputs/新しいメモ.md'), '# 新規\n');

  const blind = await call(client, 'vault_write', { path: 'CLAUDE.md', content: '消えちゃう\n' });
  assert.ok(blind.isError); assert.match(blind.text, /既にあります/);
  assert.equal(fake.text('CLAUDE.md'), '# Vault の憲法\n');

  const rev = fake.rev('CLAUDE.md');
  const over = await call(client, 'vault_write', { path: 'CLAUDE.md', content: '# 改訂\n', rev });
  assert.ok(!over.isError, over.text);
  assert.equal(fake.text('CLAUDE.md'), '# 改訂\n');

  const stale = await call(client, 'vault_write', { path: 'CLAUDE.md', content: '# 古い版から\n', rev });
  assert.ok(stale.isError); assert.match(stale.text, /別の場所で更新/);
  assert.equal(fake.text('CLAUDE.md'), '# 改訂\n');
});

test('追記：末尾に足す。無ければ作る', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);
  const a = await call(client, 'vault_append', { path: 'daily/2026-10-01.md', content: '- 21:00 Vault MCP を作った' });
  assert.ok(!a.isError, a.text);
  assert.equal(fake.text('daily/2026-10-01.md'), '# 10/1\n- 21:00 Vault MCP を作った\n');

  const b = await call(client, 'vault_append', { path: 'daily/2026-10-02.md', content: '# 10/2' });
  assert.equal(b.json.created, true);
  assert.equal(fake.text('daily/2026-10-02.md'), '# 10/2\n');
});

test('Vault の外には出られない', async t => {
  const { dbx, fake } = setup();
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_write', { path: '../../秘密.md', content: 'x' });
  assert.ok(r.isError); assert.match(r.text, /使えないパス/);
  const l = await call(client, 'vault_list', { path: '..' });
  assert.ok(l.isError);
  assert.ok(fake.calls.every(c => !c.arg || JSON.parse(c.arg).path?.toLowerCase().startsWith(ROOT.toLowerCase()) !== false));
});

test('検索：パスと当たり方を返す', async t => {
  const { dbx } = setup();
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_search', { query: '監査' });
  assert.match(r.text, /wiki\/cases\/浦和Chappy\.md\tcontent/);
  const none = await call(client, 'vault_search', { query: 'ありえない語' });
  assert.match(none.text, /ありませんでした/);
});

test('Dropbox が未設定なら、何をすればいいかを返す', async t => {
  const { dbx } = setup({});
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_read', { path: 'CLAUDE.md' });
  assert.ok(r.isError);
  assert.match(r.text, /\/api\/auth/);
});

test('リフレッシュトークンが無効なら、認可のやり直しを促す', async t => {
  const { dbx } = setup({ DROPBOX_APP_KEY: 'appkey123', DROPBOX_REFRESH_TOKEN: 'revoked' });
  const client = await connect(dbx, t);
  const r = await call(client, 'vault_list', {});
  assert.ok(r.isError);
  assert.match(r.text, /トークン更新に失敗.*認可をやり直/);
});
