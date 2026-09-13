# ChatGPT Enter Key（Vivaldi / Chrome 互換拡張・Manifest V3）

ChatGPT の入力欄での Enter キー挙動だけを変える、最小構成の拡張機能です。

| 操作 | 挙動 |
| --- | --- |
| `Enter` | 改行（送信しない） |
| `Shift+Enter` | 改行（既定動作のまま・干渉しない） |
| `Ctrl+Enter`（Mac では `Cmd+Enter`） | 送信 |
| `Alt+Enter` | 何もしない（通常入力を妨げない） |
| 日本語 IME 変換中の `Enter` | 絶対に横取りしない |

対象サイトは `https://chatgpt.com/*` のみ。権限は 0、background service worker・popup・設定画面なし。

## 1. ファイル一覧と役割

```
chatgpt-enter-key/
├── manifest.json   # MV3 定義。content_scripts で chatgpt.com に content.js を注入するだけ
├── content.js      # 全ロジック（入力欄判定 / IME 判定 / Enter・Ctrl+Enter 処理）
└── README.md       # 本ファイル
```

### content.js の仕組み（要点）

- **EventListener の位置**: `window` の **keydown キャプチャ段**に登録する。
  ChatGPT 本体（React のルート委譲ハンドラなど）より先に立てるため、
  `stopPropagation()` だけで送信ハンドラに到達を止められる。
- **Enter → 改行**: `preventDefault()` は使わない。
  `stopPropagation()` のみで、ブラウザ／エディタ自身の既定の改行（DOM 更新）を使いきる。
  合成イベントの偽造や `innerHTML` 書き換えは行わないので、React / ProseMirror の状態を壊しにくい。
- **Ctrl+Enter → 送信**: `KeyboardEvent` を再発行しない。
  送信ボタン（`data-testid="compose-send-button"` など候補 + `aria-label` 名称一致のフォールバック）を
  探して有効なら `click()`。ボタンが見つからない場合はイベントを素通しする。
  400ms 未満の連続発火は無視して二重送信を防ぐ。
- **入力欄の判定（イベント委譲）**: 要素参照は一切保持せず、毎回 `event.target`
  （またはその祖先）が ChatGPT の入力欄かを判定する。SPA で DOM が再生成されても成立する。
  - 実入力欄は `textarea` ではなく ProseMirror の `contenteditable="true"` div。
    実 DOM 基準の特徴量として `contenteditable="true"` + `role="textbox"` +
    `aria-multiline="true"`（＋おまけで `id="prompt-textarea"`）を肯定条件に使う。
  - 否定条件: 非表示要素（`[hidden]`・`[aria-hidden="true"]`・`getClientRects()` 空・
    `checkVisibility()` false）、**`name="prompt-textarea"` の fallback `textarea`**、
    検索欄（`[role=searchbox]`・`input[type=search]`・`input[name=search]`）、
    コード編集域（CodeMirror / Monaco / `[role=code]`）。
  - 生成された class 名（`wcDTda_*` など）と `aria-label` は**入力欄判定に一切使わない**
    （`aria-label` は送信ボタン候補の最終フォールバックのみ）。
- **IME 対策**: `event.isComposing`、`event.keyCode === 229`、
  `compositionstart`〜`compositionend` の自前フラグ、
  および `compositionend` 直後 100ms の猶予窓（変換確定 Enter を拾わない）の 4 段構え。

## 2. Vivaldi への読み込み手順

1. `vivaldi://extensions/` を開く
2. 右下の「**デベロッパーモード**」を ON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このリポジトリ内の **`chatgpt-enter-key/` フォルダ**（`manifest.json` がある場所）を選ぶ
5. `https://chatgpt.com/` を **タブごと閉じて開き直す**（既存タブには反映されない）

無効化は拡張カードのトグル、削除は「削除」。更新は拡張カードの「更新」→ タブ再読み込み。

## 3. 手動テスト項目

入力欄にカーソルがある状態で確認する。

- [ ] `Enter` だけで改行になり、**送信されない**
- [ ] `Shift+Enter` で改行（従来どおり）
- [ ] `Ctrl+Enter` で送信される
- [ ] `Ctrl+Enter` を連打・長押ししても**二重送信されない**
- [ ] 入力が空のとき `Ctrl+Enter` を押しても何も起きない（送信ボタン無効のため素通し）
- [ ] `Alt+Enter` / `AltGr+Enter` で既存動作が変わらない
- [ ] 日本語入力: 「かんじ」→ `Enter`（変換確定）→ 変換が確定するだけで送信・改行されない
- [ ] 日本語入力: 変換確定直後の `Enter` / `Ctrl+Enter` が誤って横取りされない
- [ ] 日本語入力: 確定後に改行・送信をそれぞれ実行すると正しく動く
- [ ] 左サイドバーの検索欄で `Enter` を押しても拡張が影響しない（検索が従来どおり）
- [ ] DevTools で composer をinspectし、`name="prompt-textarea"` の**非表示 fallback textarea** に
      Enter が介入していない（実入力欄 `div#prompt-textarea` だけが対象）
- [ ] 新規チャット作成 / 履歴選択 / サイドバー折り返し後に **DOM が再生成されても**機能する
      （要素を保持していないことの確認）
- [ ] 生成中の `Enter` / `Ctrl+Enter` で Stop ボタンが誤って押されない
- [ ] Canvas / コード編集画面などの `Enter` が従来どおり（インデント・改行）
- [ ] `Enter` 改行が ChatGPT 側の状態に反映され、送信時に改行として届く
- [ ] `Ctrl+Z` などの Undo / Redo、ペースト後の改行が壊れない
- [ ] ページ遷移（新規チャット・履歴選択）後もそのまま機能する

## 4. 既知の弱点

- **DOM 依存**: `#prompt-textarea`、`#composer`、`data-testid="compose-send-button"` は ChatGPT の改版で変わると検出に失敗する。その場合 `Ctrl+Enter` は無害に素通しされ、`Enter` の改行化も効かないことがある。
- **既定改行に頼っている**: `Enter` はブラウザ／エディタの既定動作に委ねているため、改版で既定動作そのものが潰されていると改行が増えない（その場合は `insertText` 系のフォールバック追加が必要）。
- **生成中の `Ctrl+Enter`**: 送信ボタンが無効になるため基本は素通しだが、`aria-label` 名称一致のフォールバックが意図しないボタンに一致する理論余地がある。
- **`Cmd+Enter`**: macOS 対策として `Ctrl+Enter` と同扱い。Linux/Windows で Superキー併用も送信になる。
- **IME 猶予窓**: `compositionend` 後 100ms 以内の `Enter` は安全側で無視する。変換確定と送信を 0.1 秒未満で連続実行すると 1 回無視されることがある。
- **例外範囲**: 入力欄判定の否定条件に無い UI（ダイアログ内の一部 textarea 等）で誤介入する可能性がある。逆に、厳格化しすぎると新 UI で効かなくなる。
- **可視性判定の副作用**: 非表示 fallback を弾くのに `getClientRects()` / `checkVisibility()` を使っているため、描画されるがサイズ 0 の特殊な composer では判定が外れる可能性がある。
- **`Ctrl+Enter` の探索範囲**: 誤クリック回避のため送信ボタンを「composer コンテナ → 編集域の直近の親」に限定。送信ボタンがより上位の祖先に移動すると検出に失敗する（その場合は無害に素通し）。
- **testing**: 実際の DOM に対する自動テストは未実施（ブラウザ手動テストのみ）。

## 5. 補足

- `chrome://` / `vivaldi://` / 拡張のオプションページなどでは動作しない（MV3 の content_scripts 仕様）。
- 設定項目は意図的に無い。挙動を変えたい場合は `content.js` 冒頭の定数
  （`SEND_GUARD_MS` / `IME_GRACE_MS`）やセレクタ配列を直接編集する。
- セレクタが合わなくなったときは、ChatGPT 側の composer 付近を DevTools で複製して
  リポジトリルートの `docs/chatgpt-composer-dom.txt` に保存しておくと、
  入力欄・送信ボタンの候補を更新する足がかりになる。
  ※ DOM サンプルは「現時点の実装の参考」であり、将来も同一 DOM である前提にはしていない
  （生成 class 名・`aria-label` に依存しない設計にしてある）。
