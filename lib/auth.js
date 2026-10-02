// /api/auth … Dropbox の認可（PKCE）と接続確認のページ。
//
//   /api/auth?key=<MCP_KEY>          状態の確認と「認可する」ボタン
//   /api/auth?key=<MCP_KEY>&go=1     Dropbox の認可画面へ飛ばす
//   /api/auth?code=…&state=…         Dropbox から戻ってくる先。リフレッシュトークンを表示する
//
// サーバーは何も保存しない（ステートレス）。PKCE の合言葉（code_verifier）は
// MCP_KEY と state の中の乱数から毎回同じものを作り直す。state には署名を付け、
// MCP_KEY を知っている人が始めた認可しか受け付けない。

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { secretMatches } from './http.js';
import { makeDropbox } from './dropbox.js';
import { vaultRoot } from './paths.js';

const SCOPES = 'account_info.read files.metadata.read files.content.read files.content.write';
const STATE_TTL_MS = 20 * 60 * 1000;

const b64url = buf => Buffer.from(buf).toString('base64url');
const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest();

export function signState(secret, data) {
  const payload = b64url(JSON.stringify(data));
  return payload + '.' + b64url(hmac(secret, 'state.' + payload)).slice(0, 32);
}

export function readState(secret, state, now = Date.now()) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const want = b64url(hmac(secret, 'state.' + payload)).slice(0, 32);
  if (!secretMatches(sig, want)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.n !== 'string' || typeof data.t !== 'number') return null;
  if (now - data.t > STATE_TTL_MS || data.t - now > 60_000) return null;
  return data;
}

export const verifierFor = (secret, nonce) => b64url(hmac(secret, 'pkce.' + nonce));   // 43 文字
export const challengeFor = verifier => b64url(createHash('sha256').update(verifier).digest());

export function baseUrl(req, env = process.env) {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') || String(host).startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, status, title, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https://www.dropbox.com"
  });
  res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#f6f5f2;--card:#fff;--line:#d9d6cf;--muted:#6b6862;--ok:#1f7a4d;--ng:#b3261e;--accent:#0b57d0}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe8;--bg:#161616;--card:#202020;--line:#3a3936;--muted:#a19e98;--ok:#62c48f;--ng:#f08b84;--accent:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 14px}
.muted{color:var(--muted);font-size:14px}.ok{color:var(--ok);font-weight:600}.ng{color:var(--ng);font-weight:600}
code,textarea,input{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{word-break:break-all}
textarea,input[type=text]{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--bg);color:var(--fg)}
textarea{height:96px;resize:vertical}
button{appearance:none;border:0;border-radius:10px;padding:12px 16px;font-size:16px;font-weight:600;background:var(--accent);color:#fff;width:100%;margin-top:10px}
ol{padding-left:20px;margin:8px 0}li{margin:4px 0}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

const copyBox = (id, value) => `
<textarea id="${id}" readonly>${esc(value)}</textarea>
<button type="button" onclick="(function(b){var t=document.getElementById('${id}');t.select();
(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).then(function(){b.textContent='コピーしました'},function(){document.execCommand('copy');b.textContent='コピーしました'})})(this)">コピー</button>`;

async function check(env, fetchImpl) {
  try {
    const dbx = makeDropbox({ env, fetchImpl });
    const acct = await dbx.account();
    const meta = await dbx.metadata(vaultRoot(env));
    return { ok: true, name: acct?.name?.display_name || '', vault: !!meta && meta['.tag'] === 'folder' };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

/** @param opts テスト用の差し替え { fetchImpl, env, now } */
export async function handleAuth(req, res, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const q = new URL(req.url, 'http://localhost').searchParams;
  const secret = env.MCP_KEY;
  if (!secret) return page(res, 500, '設定が足りません', '<div class="card ng">MCP_KEY が設定されていません</div>');

  const redirectUri = baseUrl(req, env) + '/api/auth';
  const root = vaultRoot(env);

  // --- Dropbox から戻ってきた ---
  if (q.has('state') && (q.has('code') || q.has('error'))) {
    const st = readState(secret, q.get('state'), now());
    if (!st) return page(res, 400, '認可をやり直してください', '<div class="card ng">期限切れか、正しくない戻り先です。最初のページからやり直してください。</div>');
    if (q.has('error')) {
      return page(res, 400, '認可されませんでした',
        `<div class="card"><p class="ng">${esc(q.get('error_description') || q.get('error'))}</p><p class="muted">最初のページからやり直せます。</p></div>`);
    }
    const appKey = env.DROPBOX_APP_KEY || st.k;
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: q.get('code'), client_id: appKey,
      code_verifier: verifierFor(secret, st.n), redirect_uri: redirectUri
    });
    const r = await fetchImpl('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.refresh_token) {
      return page(res, 400, 'トークンを受け取れませんでした',
        `<div class="card"><p class="ng">${esc(json.error_description || json.error || r.status)}</p>` +
        '<p class="muted">Dropbox アプリの Redirect URI がこのページの URL と一字一句同じか確かめて、最初からやり直してください。</p></div>');
    }
    const granted = String(json.scope || '');
    const missing = SCOPES.split(' ').filter(s => !granted.split(' ').includes(s));
    const test = await check({ ...env, DROPBOX_APP_KEY: appKey, DROPBOX_REFRESH_TOKEN: json.refresh_token }, fetchImpl);
    const testLine = test.ok
      ? `<p class="${test.vault ? 'ok' : 'ng'}">${test.vault ? '接続できました' : '接続はできましたが Vault のフォルダが見つかりません'}` +
        `（${esc(test.name)}）</p><p class="muted">Vault: <code>${esc(root)}</code></p>`
      : `<p class="ng">試しに繋いだら失敗しました: ${esc(test.detail)}</p>`;

    return page(res, 200, 'Dropbox と繋がりました', `
<div class="card">${testLine}
${missing.length ? `<p class="ng">足りない権限: ${esc(missing.join(', '))}。Dropbox アプリの Permissions で印を付けて Submit し、やり直してください。</p>` : ''}
</div>
<div class="card">
<p><b>DROPBOX_REFRESH_TOKEN</b></p>
${copyBox('rt', json.refresh_token)}
${env.DROPBOX_APP_KEY ? '' : `<p style="margin-top:14px"><b>DROPBOX_APP_KEY</b></p>${copyBox('ak', appKey)}`}
</div>
<div class="card"><p>この値を Vercel のこのプロジェクトの Settings → Environment Variables に入れて（Production）、再デプロイすれば使えるようになります。</p>
<p class="muted">リフレッシュトークンは Dropbox の合鍵です。人に見せないでください。漏れたら Dropbox の「接続済みアプリ」から外せば無効になります。</p></div>`);
  }

  // --- ここから先は合鍵が要る ---
  if (!secretMatches(q.get('key'), secret)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }

  if (q.get('go') === '1') {
    const appKey = env.DROPBOX_APP_KEY || (q.get('app_key') || '').trim();
    if (!/^[a-z0-9]{6,40}$/i.test(appKey)) {
      return page(res, 400, 'App key を入れてください', '<div class="card ng">Dropbox アプリの App key が空か、形が違います。前のページに戻って入れ直してください。</div>');
    }
    const n = b64url(randomBytes(12));
    const state = signState(secret, env.DROPBOX_APP_KEY ? { n, t: now() } : { n, t: now(), k: appKey });
    const u = new URL('https://www.dropbox.com/oauth2/authorize');
    u.search = new URLSearchParams({
      client_id: appKey, response_type: 'code', token_access_type: 'offline',
      code_challenge: challengeFor(verifierFor(secret, n)), code_challenge_method: 'S256',
      redirect_uri: redirectUri, state, scope: SCOPES
    }).toString();
    res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }

  // --- 状態の確認 ---
  let status;
  if (env.DROPBOX_APP_KEY && env.DROPBOX_REFRESH_TOKEN) {
    const t = await check(env, fetchImpl);
    status = t.ok
      ? `<p class="${t.vault ? 'ok' : 'ng'}">${t.vault ? '繋がっています' : '繋がっていますが Vault のフォルダが見つかりません'}（${esc(t.name)}）</p>`
      : `<p class="ng">繋がっていません: ${esc(t.detail)}</p>`;
  } else {
    status = '<p class="ng">まだ繋がっていません</p>';
  }

  return page(res, 200, 'Vault MCP の接続', `
<div class="card">${status}<p class="muted">Vault: <code>${esc(root)}</code></p></div>
<div class="card">
<p>Dropbox アプリの <b>Redirect URI</b> にはこれを登録します:</p>
${copyBox('ru', redirectUri)}
</div>
<form class="card" method="get" action="/api/auth">
<input type="hidden" name="key" value="${esc(q.get('key'))}">
<input type="hidden" name="go" value="1">
${env.DROPBOX_APP_KEY
    ? '<p class="muted">App key は設定済みです。</p>'
    : '<p><b>App key</b>（Dropbox アプリの Settings にある文字列）</p><input type="text" name="app_key" autocomplete="off" autocapitalize="off" spellcheck="false" required>'}
<button type="submit">${env.DROPBOX_REFRESH_TOKEN ? 'Dropbox で認可し直す' : 'Dropbox で認可する'}</button>
</form>`);
}
