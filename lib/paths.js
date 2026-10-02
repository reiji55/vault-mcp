// Vault の中だけを指すように、受け取ったパスを整える。純粋関数。
//
// ツールに渡すのは Vault 内の相対パス（"wiki/cases/foo.md"）。
// Dropbox の絶対パスに直すのはここだけで、".." などで外に出るものはここで弾く。

export const DEFAULT_ROOT = '/アプリ/remotely-save/Claude memory';

export function vaultRoot(env = process.env) {
  let r = String(env.VAULT_ROOT || DEFAULT_ROOT).normalize('NFC').trim().replace(/\/+$/, '');
  if (!r.startsWith('/')) r = '/' + r;
  return r;
}

const lower = s => s.toLowerCase();

/** 相対パス → Dropbox の絶対パス。allowRoot のときだけ空（＝Vault 直下）を許す。 */
export function toDropbox(rel, root = vaultRoot(), { allowRoot = false } = {}) {
  let p = String(rel ?? '').normalize('NFC').replace(/\\/g, '/').trim();

  // Vault の絶対パスで渡されても受ける（Dropbox は大文字小文字を区別しない）
  if (lower(p) === lower(root)) p = '';
  else if (lower(p).startsWith(lower(root) + '/')) p = p.slice(root.length + 1);

  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) {
    if (allowRoot) return root;
    throw new Error('パスが空です。Vault 内の相対パスで指定してください（例 "wiki/cases/foo.md"）');
  }
  const parts = p.split('/');
  if (parts.some(s => s === '' || s === '.' || s === '..')) {
    throw new Error(`使えないパスです: ${rel}（".." や空の区切りは使えません）`);
  }
  return root + '/' + parts.join('/');
}

/** Dropbox の path_display → Vault 内の相対パス。Vault 直下は ""。 */
export function toRel(display, root = vaultRoot()) {
  const d = String(display || '');
  if (lower(d) === lower(root)) return '';
  if (lower(d).startsWith(lower(root) + '/')) return d.slice(root.length + 1);
  return d;
}

/** ".obsidian" や ".trash" のように、どこかの区切りがドットで始まるもの。 */
export function isHidden(rel) {
  return String(rel).split('/').some(s => s.startsWith('.'));
}
