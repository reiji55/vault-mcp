// MCP の HTTP 入口。Vercel の関数からもテストのサーバーからも同じものを使う。
// ステートレス（セッションを持たない）ので、リクエストごとに立てて閉じる。

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { secretMatches, bodyOf } from './http.js';

function deny(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

/** ホスト側がパラメータを渡してこない場合に備えて URL からも拾う。 */
export function keyFromUrl(url = '') {
  const m = String(url).match(/\/mcp\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** @param dbx テスト用の差し替え。省略で本物の Dropbox */
export async function handle(req, res, key, dbx) {
  if (!process.env.MCP_KEY) return deny(res, 500, 'MCP_KEY が設定されていません');
  if (!secretMatches(key || keyFromUrl(req.url), process.env.MCP_KEY)) return deny(res, 404, 'not found');

  const server = dbx ? createServer(dbx) : createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // ステートレス
    enableJsonResponse: true         // SSE を張らず JSON で返す（サーバーレス向け）
  });

  res.on('close', () => { transport.close(); server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, bodyOf(req));
  } catch (e) {
    if (!res.headersSent) deny(res, 500, String(e.message || e));
  }
}
