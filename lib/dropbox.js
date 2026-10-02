// Dropbox API。トークンは環境変数からのみ読む。引数でも設定でも受け取らない。
//
// 認可は PKCE（/api/auth で取る）。その場合リフレッシュには App key だけで足り、
// App secret は要らない。DROPBOX_APP_SECRET があれば添える（通常の認可で取った場合）。

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

/**
 * Dropbox-API-Arg ヘッダーは ASCII しか通らない。日本語のパスは \uXXXX に逃がす。
 * （JSON としては同じ意味なので、Dropbox 側でそのまま元に戻る）
 */
export function headerJson(obj) {
  return JSON.stringify(obj).replace(/[^\x20-\x7e]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Dropbox の言い分を捨てずに、何をすればいいかが分かる文にする。 */
export class DropboxError extends Error {
  constructor(message, { status, summary, kind } = {}) {
    super(message);
    this.status = status;
    this.summary = summary || '';
    this.kind = kind || 'other';   // not_found / conflict / auth / scope / other
  }
}

async function toError(res, what) {
  let raw = '';
  try { raw = await res.text(); } catch { /* 本文なし */ }
  let summary = raw;
  try { const j = JSON.parse(raw); summary = j.error_summary || j.error_description || j.error || raw; } catch { /* 文字列のまま */ }
  summary = String(summary).slice(0, 300);
  const s = summary.toLowerCase();

  if (res.status === 401) {
    return new DropboxError(`Dropbox の認証が通りません（${summary}）。/api/auth で認可をやり直してください`,
      { status: 401, summary, kind: 'auth' });
  }
  if (s.includes('missing_scope')) {
    return new DropboxError(
      `Dropbox アプリの権限が足りません（${summary}）。Permissions で files.content.write などに印を付けて Submit したあと、認可をやり直してください`,
      { status: res.status, summary, kind: 'scope' });
  }
  if (s.includes('not_found')) {
    return new DropboxError(`見つかりません（${what}）`, { status: res.status, summary, kind: 'not_found' });
  }
  if (s.includes('conflict')) {
    return new DropboxError(`競合しました（${what}）: ${summary}`, { status: res.status, summary, kind: 'conflict' });
  }
  if (res.status === 429 || s.includes('too_many')) {
    return new DropboxError(`Dropbox が混み合っています。少し待ってやり直してください（${summary}）`,
      { status: res.status, summary, kind: 'other' });
  }
  return new DropboxError(`Dropbox API ${res.status}（${what}）: ${summary}`, { status: res.status, summary });
}

// サーバーレスの同じインスタンスが温まっている間はトークンを使い回す
let cache = null;
export function resetTokenCache() { cache = null; }

export function makeDropbox({ fetchImpl = fetch, env = process.env, now = () => Date.now() } = {}) {
  async function token() {
    const appKey = env.DROPBOX_APP_KEY;
    const refresh = env.DROPBOX_REFRESH_TOKEN;
    if (!appKey || !refresh) {
      throw new DropboxError(
        'Dropbox がまだ繋がっていません（DROPBOX_APP_KEY / DROPBOX_REFRESH_TOKEN が未設定）。' +
        '/api/auth?key=<MCP_KEY> を開いて認可し、出てきた値を Vercel の環境変数に入れて再デプロイしてください',
        { kind: 'auth' });
    }
    if (cache && cache.refresh === refresh && cache.exp > now() + 60_000) return cache.token;

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: appKey });
    if (env.DROPBOX_APP_SECRET) body.set('client_secret', env.DROPBOX_APP_SECRET);
    const res = await fetchImpl(API + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) {
      const e = await toError(res, 'トークン更新');
      throw new DropboxError(`Dropbox のトークン更新に失敗しました（${e.summary}）。/api/auth で認可をやり直してください`,
        { status: res.status, summary: e.summary, kind: 'auth' });
    }
    const json = await res.json();
    cache = { token: json.access_token, exp: now() + (json.expires_in || 14400) * 1000, refresh };
    return cache.token;
  }

  async function rpc(endpoint, args, what = endpoint) {
    const t = await token();
    const res = await fetchImpl(`${API}/2/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? null)
    });
    if (!res.ok) throw await toError(res, what);
    return res.json();
  }

  return {
    token,

    /** @returns {{ text, rev, modified, size, path_display }} */
    async download(path) {
      const t = await token();
      const res = await fetchImpl(`${CONTENT}/2/files/download`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Dropbox-API-Arg': headerJson({ path }) }
      });
      if (!res.ok) throw await toError(res, path);
      const meta = JSON.parse(res.headers.get('dropbox-api-result') || '{}');
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        text: buf.toString('utf8'),
        rev: meta.rev, modified: meta.server_modified, size: meta.size, path_display: meta.path_display || path
      };
    },

    /**
     * rev を渡すと「その版のときだけ上書き」。渡さないと「新規のときだけ作る」。
     * どちらも、ほかの端末が先に書き換えていたら競合で止まる（黙って上書きしない）。
     */
    async upload(path, text, { rev } = {}) {
      const t = await token();
      const mode = rev ? { '.tag': 'update', update: rev } : 'add';
      const res = await fetchImpl(`${CONTENT}/2/files/upload`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + t,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerJson({ path, mode, autorename: false, mute: true, strict_conflict: true })
        },
        body: Buffer.from(text, 'utf8')
      });
      if (!res.ok) throw await toError(res, path);
      const m = await res.json();
      return { rev: m.rev, modified: m.server_modified, size: m.size, path_display: m.path_display || path };
    },

    /** ファイルならメタデータ、無ければ null。 */
    async metadata(path) {
      try {
        return await rpc('files/get_metadata', { path }, path);
      } catch (e) {
        if (e.kind === 'not_found') return null;
        throw e;
      }
    },

    /** フォルダの中身。続きのページも辿る。cap を超えたら truncated。 */
    async list(path, { recursive = false, cap = 5000 } = {}) {
      let page = await rpc('files/list_folder',
        { path, recursive, include_deleted: false, include_non_downloadable_files: false, limit: 2000 }, path);
      const entries = [...page.entries];
      while (page.has_more && entries.length < cap) {
        page = await rpc('files/list_folder/continue', { cursor: page.cursor }, path);
        entries.push(...page.entries);
      }
      return { entries: entries.slice(0, cap), truncated: entries.length > cap || !!page.has_more };
    },

    async search(query, path, { max = 20 } = {}) {
      const r = await rpc('files/search_v2', {
        query,
        options: { path, max_results: max, file_status: 'active', filename_only: false }
      }, '検索');
      const hits = (r.matches || [])
        .map(m => ({ meta: m.metadata?.metadata || {}, match: m.match_type?.['.tag'] || '' }))
        .filter(h => h.meta.path_display);
      return { hits, has_more: !!r.has_more };
    },

    async account() {
      return rpc('users/get_current_account', null, 'アカウント');
    }
  };
}
