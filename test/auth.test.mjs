// 認可ページ（/api/auth）を、偽の Dropbox を相手に最初から最後まで通す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth, signState, readState, verifierFor, challengeFor } from '../lib/auth.js';
import { resetTokenCache } from '../lib/dropbox.js';
import { fakeDropbox, ROOT } from './fake-dropbox.mjs';

const KEY = 'test-key-0123456789';

/** handleAuth を呼んで、ステータス・ヘッダー・本文を受け取る */
async function hit(path, env, fetchImpl, now) {
  const req = { url: path, headers: { host: 'vault-mcp-reiji-go.vercel.app' } };
  const out = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(s, h) { out.status = s; out.headers = h || {}; },
    end(b) { out.body = b || ''; }
  };
  await handleAuth(req, res, { env, fetchImpl, now });
  return out;
}

test('state は署名つき。改ざん・期限切れは受けない', () => {
  const s = signState(KEY, { n: 'abc', t: 1000 });
  assert.deepEqual(readState(KEY, s, 2000), { n: 'abc', t: 1000 });
  assert.equal(readState('other-key-000000000', s, 2000), null);
  assert.equal(readState(KEY, s.replace(/^./, 'x'), 2000), null);
  assert.equal(readState(KEY, s, 1000 + 21 * 60 * 1000), null);
  assert.match(verifierFor(KEY, 'abc'), /^[A-Za-z0-9_-]{43}$/);
});

test('合鍵なしでは何も見せない', async () => {
  const r = await hit('/api/auth', { MCP_KEY: KEY }, fetch);
  assert.equal(r.status, 404);
});

test('未接続：Redirect URI と App key の入力欄を出す', async () => {
  const r = await hit(`/api/auth?key=${KEY}`, { MCP_KEY: KEY }, fetch);
  assert.equal(r.status, 200);
  assert.match(r.body, /まだ繋がっていません/);
  assert.match(r.body, /https:\/\/vault-mcp-reiji-go\.vercel\.app\/api\/auth/);
  assert.match(r.body, /name="app_key"/);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('最初から最後まで：App key を入れて認可 → リフレッシュトークンが出て、そのまま繋がる', async () => {
  resetTokenCache();
  const fake = fakeDropbox({ [`${ROOT}/CLAUDE.md`]: '# x\n' });
  const env = { MCP_KEY: KEY };
  const now = () => 1_790_000_000_000;

  // 1) 認可画面へ
  const go = await hit(`/api/auth?key=${KEY}&go=1&app_key=abc123xyz`, env, fake.fetchImpl, now);
  assert.equal(go.status, 302);
  const to = new URL(go.headers.Location);
  assert.equal(to.origin + to.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(to.searchParams.get('client_id'), 'abc123xyz');
  assert.equal(to.searchParams.get('token_access_type'), 'offline');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://vault-mcp-reiji-go.vercel.app/api/auth');
  assert.match(to.searchParams.get('scope'), /files\.content\.write/);

  // 2) ユーザーが「許可」→ Dropbox が戻してくる
  fake.approve('the-code', to.searchParams.get('code_challenge'));
  const back = await hit(`/api/auth?code=the-code&state=${encodeURIComponent(to.searchParams.get('state'))}`, env, fake.fetchImpl, now);
  assert.equal(back.status, 200, back.body);
  assert.match(back.body, /good-refresh/);
  assert.match(back.body, /abc123xyz/, 'App key が未設定なので、入れる値として一緒に出す');
  assert.match(back.body, /接続できました（テストのファミリー）/);

  // 3) 同じコードの使い回しは通らない
  const again = await hit(`/api/auth?code=the-code&state=${encodeURIComponent(to.searchParams.get('state'))}`, env, fake.fetchImpl, now);
  assert.equal(again.status, 400);
});

test('state を偽造した戻りは受けない', async () => {
  const fake = fakeDropbox();
  const bad = signState('other-key-000000000', { n: 'x', t: Date.now() });
  const r = await hit(`/api/auth?code=c&state=${bad}`, { MCP_KEY: KEY }, fake.fetchImpl);
  assert.equal(r.status, 400);
  assert.match(r.body, /やり直してください/);
});

test('接続済みなら状態を確かめて表示する', async () => {
  resetTokenCache();
  const fake = fakeDropbox({ [`${ROOT}/CLAUDE.md`]: '# x\n' });
  const env = { MCP_KEY: KEY, DROPBOX_APP_KEY: 'abc123xyz', DROPBOX_REFRESH_TOKEN: 'good-refresh' };
  const r = await hit(`/api/auth?key=${KEY}`, env, fake.fetchImpl);
  assert.match(r.body, /繋がっています（テストのファミリー）/);
  assert.doesNotMatch(r.body, /name="app_key"/);
  // 認可し直すときは、ヘッダーに日本語が混ざらないか（Vault の確認で使う）
  assert.ok(fake.calls.filter(c => c.arg).every(c => /^[\x20-\x7e]+$/.test(c.arg)));
  assert.equal(challengeFor('x').length, 43);
});
