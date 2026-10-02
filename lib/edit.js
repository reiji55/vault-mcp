// 本文の書き換え。純粋関数（Dropbox には触らない）。

function count(text, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

const toCRLF = s => s.replace(/\r?\n/g, '\r\n');

/**
 * 置換を順番に当てる。1件でも当たらなければ何も書き換えない（全部か無しか）。
 * @param {string} text
 * @param {{ old_str: string, new_str?: string, replace_all?: boolean }[]} edits
 * @returns {{ text: string, replaced: number[] }}
 */
export function applyEdits(text, edits) {
  let out = text;
  const replaced = [];
  edits.forEach((e, i) => {
    const tag = edits.length > 1 ? `edits[${i}]: ` : '';
    let oldStr = e.old_str ?? '';
    let newStr = e.new_str ?? '';
    if (!oldStr) throw new Error(`${tag}old_str が空です`);

    let n = count(out, oldStr);
    // Windows 改行のファイルに LF で渡された場合だけ、改行をそろえて探し直す
    if (n === 0 && out.includes('\r\n') && oldStr.includes('\n') && !oldStr.includes('\r\n')) {
      const crlf = toCRLF(oldStr);
      const m = count(out, crlf);
      if (m > 0) { oldStr = crlf; newStr = toCRLF(newStr); n = m; }
    }
    if (n === 0) {
      throw new Error(
        `${tag}old_str が見つかりません。空白・改行・全角半角まで一字一句同じにしてください` +
        '（先の edits で書き換わった部分は、書き換え後の文で指定）');
    }
    if (n > 1 && !e.replace_all) {
      throw new Error(`${tag}old_str が ${n} 箇所あります。前後の文を足して1箇所に絞るか、replace_all: true を付けてください`);
    }
    // 関数で渡して、new_str 中の "$&" などを特別扱いさせない
    out = e.replace_all ? out.split(oldStr).join(newStr) : out.replace(oldStr, () => newStr);
    replaced.push(n);
  });
  return { text: out, replaced };
}

/** 末尾に足す。既存の最後が改行で終わっていなければ1つ挟み、足した分も改行で閉じる。 */
export function appendText(text, add) {
  const body = add.endsWith('\n') ? add : add + '\n';
  if (!text) return body;
  return text.endsWith('\n') ? text + body : text + '\n' + body;
}
