// Dropbox の認可と接続確認のページ。中身は lib/auth.js。
import { handleAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  await handleAuth(req, res);
}
