import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDropbox, toRel, isHidden, vaultRoot, DEFAULT_ROOT } from '../lib/paths.js';
import { applyEdits, appendText } from '../lib/edit.js';
import { headerJson } from '../lib/dropbox.js';

const R = DEFAULT_ROOT;

test('相対パスを Vault の中の絶対パスにする', () => {
  assert.equal(toDropbox('wiki/cases/a.md', R), `${R}/wiki/cases/a.md`);
  assert.equal(toDropbox('/CLAUDE.md', R), `${R}/CLAUDE.md`);
  assert.equal(toDropbox('daily/', R), `${R}/daily`);
  assert.equal(toDropbox(`${R}/wiki/a.md`, R), `${R}/wiki/a.md`, 'Vault の絶対パスでも受ける');
  assert.equal(toDropbox('/アプリ/REMOTELY-SAVE/claude memory/x.md', R), `${R}/x.md`, '大文字小文字は区別しない');
  assert.equal(toDropbox('', R, { allowRoot: true }), R);
});

test('Vault の外を指すパスは弾く', () => {
  assert.throws(() => toDropbox('../secret.md', R), /使えないパス/);
  assert.throws(() => toDropbox('wiki/../../x.md', R), /使えないパス/);
  assert.throws(() => toDropbox('wiki//x.md', R), /使えないパス/);
  assert.throws(() => toDropbox('./x.md', R), /使えないパス/);
  assert.throws(() => toDropbox('', R), /パスが空/);
  // 別の場所の絶対パスは、Vault 内の相対パスとして扱われる（外には出ない）
  assert.equal(toDropbox('/Documents/x.md', R), `${R}/Documents/x.md`);
});

test('濁点が分かれた形（NFD）で来ても NFC にそろえる', () => {
  const nfd = 'ノート/プラン.md'.normalize('NFD');
  assert.notEqual(nfd, 'ノート/プラン.md');
  assert.equal(toDropbox(nfd, R), `${R}/ノート/プラン.md`);
});

test('VAULT_ROOT は環境変数で変えられる', () => {
  assert.equal(vaultRoot({}), R);
  assert.equal(vaultRoot({ VAULT_ROOT: 'Notes/vault/' }), '/Notes/vault');
});

test('Dropbox のパスを相対パスに戻す', () => {
  assert.equal(toRel(`${R}/wiki/a.md`, R), 'wiki/a.md');
  assert.equal(toRel(R, R), '');
  assert.equal(toRel('/アプリ/remotely-save/claude memory/Wiki/A.md', R), 'Wiki/A.md');
  assert.ok(isHidden('.obsidian/app.json'));
  assert.ok(isHidden('wiki/.trash/x.md'));
  assert.ok(!isHidden('wiki/a.md'));
});

test('Dropbox-API-Arg は ASCII だけになる', () => {
  const h = headerJson({ path: `${R}/日報.md`, mode: 'add' });
  assert.match(h, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(h), { path: `${R}/日報.md`, mode: 'add' });
});

test('置換：1箇所だけ当たれば置き換える', () => {
  const r = applyEdits('a\nstatus: 進行中\nb\n', [{ old_str: 'status: 進行中', new_str: 'status: 完了' }]);
  assert.equal(r.text, 'a\nstatus: 完了\nb\n');
  assert.deepEqual(r.replaced, [1]);
});

test('置換：当たらない／複数当たるときは止まる', () => {
  assert.throws(() => applyEdits('abc', [{ old_str: 'x', new_str: 'y' }]), /見つかりません/);
  assert.throws(() => applyEdits('- [ ] a\n- [ ] b\n', [{ old_str: '- [ ]', new_str: '- [x]' }]), /2 箇所/);
  const r = applyEdits('- [ ] a\n- [ ] b\n', [{ old_str: '- [ ]', new_str: '- [x]', replace_all: true }]);
  assert.equal(r.text, '- [x] a\n- [x] b\n');
  assert.deepEqual(r.replaced, [2]);
});

test('置換：複数の edits は上から順。1つでも外れたら何も変えない', () => {
  const src = 'one\ntwo\nthree\n';
  const r = applyEdits(src, [{ old_str: 'one', new_str: '1' }, { old_str: '1\ntwo', new_str: '1\n2' }]);
  assert.equal(r.text, '1\n2\nthree\n');
  assert.throws(() => applyEdits(src, [{ old_str: 'one', new_str: '1' }, { old_str: 'nope' }]), /edits\[1\]/);
});

test('置換：new_str の $ はそのまま入る／省略で削除', () => {
  assert.equal(applyEdits('price: X', [{ old_str: 'X', new_str: '$& $1 $$' }]).text, 'price: $& $1 $$');
  assert.equal(applyEdits('keep\ndrop me\n', [{ old_str: 'drop me\n' }]).text, 'keep\n');
});

test('置換：CRLF のファイルに LF で渡しても当たる', () => {
  const r = applyEdits('a\r\nb\r\nc\r\n', [{ old_str: 'a\nb', new_str: 'A\nB' }]);
  assert.equal(r.text, 'A\r\nB\r\nc\r\n');
});

test('追記：改行を挟んで足し、改行で閉じる', () => {
  assert.equal(appendText('', 'x'), 'x\n');
  assert.equal(appendText('a\n', 'x'), 'a\nx\n');
  assert.equal(appendText('a', 'x\n'), 'a\nx\n');
});
