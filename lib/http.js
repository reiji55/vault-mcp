// HTTP の入口で共通に要るもの（task-3days の MCP と同じ作り）。

import { timingSafeEqual } from 'node:crypto';

/**
 * 合言葉の突き合わせ。長さが同じときだけ中身を見るので、
 * どこまで一致したかが時間に出ない（総当たりの手掛かりを与えない）。
 */
export function secretMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ホストが本文を解析済みのことも、生のままのこともある。どちらでも受ける。 */
export function bodyOf(req) {
  const b = req.body;
  if (b == null) return undefined;
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return undefined; }
  }
  return b;
}
