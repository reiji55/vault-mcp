// Dropbox のふりをする fetch。テストで本物の API の代わりに差し込む。
//
// 本物と同じく、Dropbox-API-Arg ヘッダーに ASCII 以外が混ざっていたら弾く
// （日本語のパスを逃がし忘れると、本番ではここで落ちる）。

import { createHash } from 'node:crypto';

export const ROOT = '/アプリ/remotely-save/Claude memory';

const escHeader = obj => JSON.stringify(obj).replace(/[^\x20-\x7e]/g,
  c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function fakeDropbox(initial = {}, { pageSize = 3 } = {}) {
  const files = new Map();     // lower → { path, text, rev, modified }
  const folders = new Map();   // lower → path
  const calls = [];
  const pending = new Map();   // 認可コード → code_challenge
  let revN = 0x100;
  let tick = 0;
  const nextRev = () => (revN++).toString(16) + '0f00d';
  const stamp = () => new Date(Date.UTC(2026, 9, 2, 0, 0, tick++)).toISOString().replace('.000', '');

  const lower = p => p.toLowerCase();
  const parentOf = p => p.slice(0, p.lastIndexOf('/'));
  function ensureFolders(p) {
    for (let d = parentOf(p); d && d !== ''; d = parentOf(d)) folders.set(lower(d), d);
  }
  function put(path, text) {
    const f = { path, text, rev: nextRev(), modified: stamp() };
    files.set(lower(path), f);
    ensureFolders(path);
    return f;
  }
  for (const [p, t] of Object.entries(initial)) put(p, t);
  folders.set(lower(ROOT), ROOT);

  const fileMeta = f => ({
    '.tag': 'file', name: f.path.split('/').pop(), path_display: f.path, path_lower: lower(f.path),
    rev: f.rev, size: Buffer.byteLength(f.text), server_modified: f.modified
  });
  const folderMeta = p => ({ '.tag': 'folder', name: p.split('/').pop(), path_display: p, path_lower: lower(p) });

  const json = (status, obj, headers = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const err = (status, summary) => json(status, { error_summary: summary, error: {} });

  function children(path, recursive) {
    const base = lower(path);
    const out = recursive ? [folderMeta(folders.get(base))] : [];
    const under = p => lower(p).startsWith(base + '/') && (recursive || !lower(p).slice(base.length + 1).includes('/'));
    for (const p of folders.values()) if (under(p)) out.push(folderMeta(p));
    for (const f of files.values()) if (under(f.path)) out.push(fileMeta(f));
    return out;
  }

  const cursors = new Map();
  function pageOf(list, offset) {
    const entries = list.slice(offset, offset + pageSize);
    const more = offset + pageSize < list.length;
    let cursor = '';
    if (more) { cursor = 'c' + cursors.size; cursors.set(cursor, { list, offset: offset + pageSize }); }
    return { entries, has_more: more, cursor };
  }

  async function fetchImpl(url, init = {}) {
    const u = String(url);
    const headers = new Headers(init.headers || {});   // ASCII 以外の値ならここで投げる（本物と同じ）
    const rawArg = headers.get('dropbox-api-arg');
    calls.push({ url: u, arg: rawArg, auth: headers.get('authorization') });
    if (rawArg && !/^[\x20-\x7e]*$/.test(rawArg)) return err(400, 'bad header: non-ascii');

    if (u === 'https://api.dropboxapi.com/oauth2/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'refresh_token') {
        if (p.get('refresh_token') !== 'good-refresh' || !p.get('client_id')) return json(400, { error: 'invalid_grant', error_description: 'refresh token is malformed' });
        return json(200, { access_token: 'at-live', token_type: 'bearer', expires_in: 14400 });
      }
      if (p.get('grant_type') === 'authorization_code') {
        const challenge = pending.get(p.get('code'));
        pending.delete(p.get('code'));
        if (!challenge) return json(400, { error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' });
        const got = createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (got !== challenge) return json(400, { error: 'invalid_grant', error_description: 'invalid code verifier' });
        return json(200, {
          access_token: 'at-live', refresh_token: 'good-refresh', expires_in: 14400,
          scope: 'account_info.read files.content.read files.content.write files.metadata.read'
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    if (headers.get('authorization') !== 'Bearer at-live') return err(401, 'invalid_access_token/');

    const arg = rawArg ? JSON.parse(rawArg) : JSON.parse(String(init.body || 'null'));
    const endpoint = u.replace(/^https:\/\/(api|content)\.dropboxapi\.com\/2\//, '');

    switch (endpoint) {
      case 'files/download': {
        const f = files.get(lower(arg.path));
        if (!f) return err(409, folders.has(lower(arg.path)) ? 'path/not_file/.' : 'path/not_found/..');
        return new Response(Buffer.from(f.text, 'utf8'), {
          status: 200, headers: { 'content-type': 'application/octet-stream', 'dropbox-api-result': escHeader(fileMeta(f)) }
        });
      }
      case 'files/upload': {
        const text = Buffer.from(init.body).toString('utf8');
        const f = files.get(lower(arg.path));
        if (arg.mode === 'add') {
          if (f && f.text === text) return json(200, fileMeta(f));
          if (f) return err(409, 'path/conflict/file/...');
        } else if (arg.mode?.['.tag'] === 'update') {
          if (!f || f.rev !== arg.mode.update) return err(409, 'path/conflict/file/..');
        } else {
          return err(400, 'unexpected mode');
        }
        const saved = put(f ? f.path : arg.path, text);
        return json(200, fileMeta(saved));
      }
      case 'files/get_metadata': {
        const f = files.get(lower(arg.path));
        if (f) return json(200, fileMeta(f));
        if (folders.has(lower(arg.path))) return json(200, folderMeta(folders.get(lower(arg.path))));
        return err(409, 'path/not_found/.');
      }
      case 'files/list_folder': {
        if (!folders.has(lower(arg.path))) return err(409, 'path/not_found/');
        return json(200, pageOf(children(arg.path, arg.recursive), 0));
      }
      case 'files/list_folder/continue': {
        const c = cursors.get(arg.cursor);
        if (!c) return err(409, 'reset/');
        return json(200, pageOf(c.list, c.offset));
      }
      case 'files/search_v2': {
        const q = lower(arg.query);
        const base = lower(arg.options?.path || '');
        const matches = [];
        for (const f of files.values()) {
          if (base && !lower(f.path).startsWith(base + '/')) continue;
          const byName = lower(f.path.split('/').pop()).includes(q);
          const byBody = lower(f.text).includes(q);
          if (byName || byBody) {
            matches.push({ match_type: { '.tag': byName ? 'filename' : 'content' }, metadata: { '.tag': 'metadata', metadata: fileMeta(f) } });
          }
        }
        return json(200, { matches: matches.slice(0, arg.options?.max_results || 100), has_more: false });
      }
      case 'users/get_current_account':
        return json(200, { name: { display_name: 'テストのファミリー' }, account_id: 'dbid:x' });
      default:
        return err(400, 'unknown endpoint ' + endpoint);
    }
  }

  return {
    fetchImpl, calls, files,
    text: rel => files.get(lower(ROOT + '/' + rel))?.text,
    rev: rel => files.get(lower(ROOT + '/' + rel))?.rev,
    /** 別の端末が書き換えた、の再現 */
    touch: (rel, text) => put(ROOT + '/' + rel, text),
    /** 認可画面でユーザーが「許可」した、の再現 */
    approve: (code, challenge) => pending.set(code, challenge)
  };
}
