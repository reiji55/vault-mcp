# Vault MCP

Dropbox 上の Obsidian Vault（`/アプリ/remotely-save/Claude memory`、remotely-save で各端末と同期）の
Markdown を、Claude から**その場で書き換える**ための MCP サーバー。

Dropbox の公式コネクタには「上書き・一部編集」が無く、直すたびに削除→作り直しになっていた。
これはその穴を埋めるだけのもの。削除・移動・名前の変更は今までどおり Dropbox コネクタを使う。

作りは task-3days の MCP（`reiji55/task-3days` の `mcp/`）と同じ。Vercel の関数で、ステートレス。

## ツール

| ツール | すること |
|---|---|
| `vault_list` | フォルダの中身。1行1件で「パス／更新日時／サイズ／rev」。`.obsidian` などは既定で省く |
| `vault_read` | 本文と rev を返す。配列で最大10件まとめて読める |
| `vault_edit` | **一部だけ置き換える。** 変更箇所だけ送ればよい。`edits` に並べれば何箇所でも1回で保存 |
| `vault_append` | 末尾に足す。無ければ作る。日報・ログ向け |
| `vault_write` | 新規作成（rev なし）か、丸ごと置き換え（rev あり） |
| `vault_search` | Dropbox の検索。本文まで探せるのは Dropbox の有料プランだけ |

パスはすべて **Vault 内の相対パス**（`wiki/cases/foo.md`）。`..` などで外には出られない。

### 上書き事故を起こさないための決まり

- 書き込みは必ず Dropbox の版（rev）を確かめてから。iPad の Obsidian などが**先に書き換えていたら、
  黙って上書きせずに競合で止まる**（`strict_conflict`）。
- `vault_write` は rev を渡さないと新規作成しかしない。既にあるファイルを rev なしで潰すことはできない。
- `vault_edit` は置き換え元が1箇所に定まらないと止まる。複数の置き換えは全部当たったときだけ保存する。
- 保存は `mute: true`（Dropbox の通知を鳴らさない）。

## 環境変数

Vercel のプロジェクト設定で入れる。**コードにもリポジトリにも書かない。**

| 変数 | 必須 | 中身 |
|---|---|---|
| `MCP_KEY` | ○ | 接続 URL の末尾に入る合鍵。長いランダム文字列 |
| `DROPBOX_APP_KEY` | ○ | Dropbox アプリの App key（秘密ではない） |
| `DROPBOX_REFRESH_TOKEN` | ○ | `/api/auth` で取るリフレッシュトークン。**これが Dropbox の合鍵** |
| `VAULT_ROOT` | | 既定 `/アプリ/remotely-save/Claude memory` |
| `BASE_URL` | | 認可の戻り先を固定したいとき。既定はアクセスされたホスト |
| `DROPBOX_APP_SECRET` | | 不要（PKCE で認可するため）。通常の認可でトークンを取った場合だけ |

## つなぎ方

1. **Dropbox アプリを作る**（https://www.dropbox.com/developers/apps → Create app）
   - Scoped access → **Full Dropbox**（App folder だと remotely-save のフォルダに届かない）
   - Permissions タブで `files.metadata.read` `files.content.read` `files.content.write` に印 → **Submit**
   - Settings タブの **Redirect URIs** に `https://<このサーバー>/api/auth` を追加
2. `https://<このサーバー>/api/auth?key=<MCP_KEY>` を開き、App key を入れて「Dropbox で認可する」
3. 出てきた `DROPBOX_REFRESH_TOKEN`（と `DROPBOX_APP_KEY`）を Vercel の環境変数に入れて再デプロイ
4. 同じページを開き直して「繋がっています」になれば完了
5. Claude のカスタムコネクタに `https://<このサーバー>/api/mcp/<MCP_KEY>` を登録

認可は PKCE なので App secret は使わない。サーバーは何も保存しない
（PKCE の合言葉は `MCP_KEY` と state の乱数から毎回同じものを作り直す。state には署名を付けている）。

リフレッシュトークンが漏れたら、Dropbox の 設定 → 接続済みアプリ からこのアプリを外せば無効になる。
`MCP_KEY` が漏れたら、作り直して再デプロイし、コネクタの URL を差し替える。

## デプロイ

Vercel のプロジェクト `vault-mcp`（本番 `https://vault-mcp-reiji-go.vercel.app`）。
Framework は Other、Build / Output は空のまま。

今は **Git 連携なしで、ファイルを直接デプロイ**している（Claude が Vercel の API で上げた）。
このリポジトリに push しても自動ではデプロイされない。
自動にしたければ、Vercel のプロジェクト設定で **Connect Git Repository** → `reiji55/vault-mcp`。

環境変数を変えたら再デプロイが要る（入れただけでは効かない）。

## ファイル

```
api/mcp/[key].js   MCP の入口。URL 末尾が合鍵。合わなければ 404
api/auth.js        Dropbox の認可と接続確認のページ
lib/handler.js     合鍵の照合と MCP トランスポート（ステートレス）
lib/server.js      ツールの定義
lib/dropbox.js     Dropbox API（トークン更新、読み書き、一覧、検索）
lib/edit.js        置換と追記（純粋関数）
lib/paths.js       相対パス ⇔ Dropbox パス。Vault の外を弾く（純粋関数）
lib/auth.js        認可ページの中身（PKCE、署名つき state）
test/              node --test で全部走る。Dropbox は偽物（test/fake-dropbox.mjs）
```

## 詰まりやすいところ

- **Dropbox-API-Arg ヘッダーは ASCII しか通らない。** 日本語のパスは `\uXXXX` に逃がしている
  （`headerJson`）。ここを外すと全部の読み書きが落ちる。テストで見張っている。
- Redirect URI は一字一句同じでないと認可が通らない。`/api/auth` のページに出る URL をそのまま登録する。
- Permissions を変えたら、**認可をやり直さないと**新しい権限は付かない。
- 環境変数は入れただけでは効かない。入れたあとに再デプロイが要る。
