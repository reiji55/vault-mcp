// /api/mcp/<MCP_KEY> がコネクタの接続先。
// URL の末尾が合鍵。合わなければ 404 を返し、存在自体を伏せる。
import { handle } from '../../lib/handler.js';

export default async function handler(req, res) {
  await handle(req, res, req.query?.key);
}
