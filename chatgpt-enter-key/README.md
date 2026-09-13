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

- **EventListener の位置**: `manifest.json` の `world` を `MAIN`、`run_at` を `document_start` にして、
  `window` の **keydown キャプチャ段**に「登録順で先頭」で立つようにしている。
  ChatGPT 本体と同じJavaScript実行環境で、ページ側より早くイベントを処理する。
- **Enter → 改行**: 元のEnterイベントの `shiftKey` をページ側からtrueに見えるようにし、
  ChatGPT自身のShift+Enter改行処理へ委任する。KeyboardEventの生成・再発行、
  `execCommand`、DOM直接書き換えは行わない。変更できない環境では送信防止を優先して停止する。
- **改行の実効チェック**: EnterをShift+Enterとして委任する直前と60ms後に composer の構造署名
  （`innerHTML.length` + `childElementCount`）を取り、変わっていなければ
  「改行が挿入されていない可能性」として warn を 1 回出す（§4）。
- **Ctrl+Enter → 送信**: `KeyboardEvent` を再発行しない。
  送信ボタン（`data-testid="compose-send-button"` など候補 + `aria-label` 名称一致のフォールバック）を
  探して有効なら `click()`。ボタンが見つからない場合はイベントを素通しする。
  400ms 未満の連続発火は無視して二重送信を防ぐ。
- **入力欄の判定（イベント委譲）**: 要素参照は一切保持せず、毎回 `event.target`
  （またはその祖先）が ChatGPT の入力欄かを判定する。SPA で DOM が再生成されても成立する。
  - 実入力欄は `textarea` ではなく ProseMirror の `contenteditable="true"` div。
    `id="prompt-textarea"`、または `contenteditable="true"` + `role="textbox"` +
    `aria-multiline="true"` に「composer 内部」か「fallback textarea の兄弟」という条件を
    組み合わせ、一般の textbox だけでは対象にしない。
  - 否定条件: 非表示要素（`[hidden]`・`[aria-hidden="true"]`・`getClientRects()` 空・
    `checkVisibility()` false）、**`name="prompt-textarea"` の fallback `textarea`**、
    検索欄（`[role=searchbox]`・`input[type=search]`・`input[name=search]`）、
    コード編集域（CodeMirror / Monaco / `[role=code]`）。
  - 生成された class 名（`wcDTda_*` など）と `aria-label` は**入力欄判定に一切使わない**
    （`aria-label` は送信ボタン候補の最終フォールバックのみ）。
- **IME 対策**: `event.isComposing`、`event.keyCode === 229`、
  `compositionstart`〜`compositionend` の自前フラグ、
  および `compositionend` 直後 100ms の猶予窓（変換確定 Enter を拾わない）の 4 段構え。
- **不良検知ログ**: 操作結果を `console` に出す（`[ChatGPT Enter Key]` 接頭辞）。
  読み込み後に検出した入力欄の **DOM 要素そのもの**も自動表示する。
  SPA が入力欄を作り直した場合は、新しい要素を再度表示する。詳細は §4。

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
- [ ] Console に `[ChatGPT Enter Key] v0.9.0 読み込み完了 (world=MAIN, run_at=document_start) ... Enter 方針=remapToShiftEnter` が 1 行だけ出ている（＝注入されている）
- [ ] Console に `ChatGPT の入力欄 DOM を検出しました:` と実際の `div#prompt-textarea` 要素が表示され、展開・inspect できる
- [ ] チャット画面で 15 秒待っても `入力欄 DOM を検出できませんでした` という警告が出ない
- [ ] `Enter` 押下で `Enter → 改行（...）` が 1 行だけ追加され、**文章タイプ中は無出力**のまま
- [ ] `localStorage.setItem('chatgptEnterKeyLogLevel','debug')` で素通し理由まで出る
- [ ] `document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'))` で
      入力欄が `accepted: true`、送信ボタンが `via: "selector"` になる
      （`accepted: false` ばかり／`via: "none"` なら §5 の弱点＝セレクタ陳腐化）
- [ ] `Enter` 押下の約 60ms 後に `composer の DOM が変わっていません` と warn が出ない
      （出た場合は既定の改行が止まっている → §4 の方針切り替え）
- [ ] スラッシュコマンド等の**候補一覧で Enter 決定**する UI が従来どおり
      （既定方針は Enter の keydown を完全に断つため、そこだけ副作用が出うる）

## 4. コンソールログ（不良検知）

DevTools（`F12`）→ Console に `[ChatGPT Enter Key]` 接頭辞で出力する。
content script のログはページのコンソールに `content.js:行番号` 付きで表示される
（見当たらない場合は Console 上部の JavaScript context セレクタで本拡張を選ぶ）。

| レベル | 内容 |
| --- | --- |
| `info`（既定） | 読み込み完了 1 行／検出した入力欄の実 DOM 要素／ `Enter → 改行（strategy: ...）` ／ `Ctrl+Enter → 送信ボタン click()` ／ 自己診断の結果 |
| `warn` | 読み込み後15秒以内に入力欄DOMが見つからない／送信ボタンが見つからない／候補は有るが押下不可／名称一致フォールバックで送信した／入力欄を特定できない状態の反復／IMEフラグ滞留／Shift+Enter委任後もcomposerのDOMが変わらない |
| `debug` | 素通しした理由（IME 変換中・Alt 併用・Shift+Enter・二重送信抑止・対象外要素）／改行が DOM に反映されたこと／ Enter keyup を対で止めたこと |

**通常のタイピングでは新しいログを出さない。** 既定（`info`）で出力するのは、
ページ読み込み時、入力欄DOMの初回検出時、Enter操作時、および異常検知時だけ。

```js
// 詳細ログの有効化 / 無音化（ページのコンソールから。拡張の context 選択は不要）
localStorage.setItem('chatgptEnterKeyLogLevel', 'debug');
localStorage.setItem('chatgptEnterKeyLogLevel', 'off');
localStorage.removeItem('chatgptEnterKeyLogLevel'); // 既定（info）に戻す

// Enter を送信ハンドラから守る方針の切り替え（下記「Enter の方針」）
localStorage.setItem('chatgptEnterKeyStrategy', 'remapToShiftEnter');
localStorage.removeItem('chatgptEnterKeyStrategy'); // 既定（remapToShiftEnter）に戻す

// 改行が DOM に反映されたかのチェックを止める（'0' で OFF）
localStorage.setItem('chatgptEnterKeyVerify', '0');
localStorage.removeItem('chatgptEnterKeyVerify');

// 「今この瞬間の DOM」で入力欄・送信ボタンが生きているか即検査
document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'));
```

入力欄の自動診断は初期表示と SPA による DOM 再生成を監視し、受理した要素を
`ChatGPT の入力欄 DOM を検出しました:` の後ろへ実 DOM オブジェクトとして表示する。
見つからなければ読み込み 15 秒後に警告する。

手動の自己診断は入力欄セレクタ 5 種の当たり状況（`accepted`）、実要素
（`composerElement`）、送信ボタンのヒット経路
（`via`: `selector` / `name` / `disabled` / `none`）を 1 件のオブジェクトで返す。
DevTools の context で本拡張を選べば `__chatgptEnterKeySelfTest()`（同じ内容）や
`__chatgptEnterKeyStats()`（操作回数カウンタ）も直接呼べる。

### 「効かない」ときの読み方

| 症状 | ログの征兆 | 対応 |
| --- | --- | --- |
| そもそも効いていない | `v0.9.0 読み込み完了` が出ていない | 拡張カードの更新後、タブを完全に閉じて開き直す／拡張が有効か／`chatgpt.com` か |
| **`Enter` が送信される（ログは出ている）** | `remappedShiftKey` を確認 | `true` でなければイベント変更に失敗。誤送信防止の停止処理が働く |
| `Enter` で改行されない | `Enter` に対するログが 1 行も無い | 入力欄を特定できていない。自己診断で `accepted: false` ばかりなら `isComposerInput` の条件を更新 |
| 改行だけ増えない | `Enter 操作後も composer の DOM が変わっていません` | 詳細ログを有効にし、`remappedShiftKey: true` と keypress / keyup の引き継ぎを確認する |
| `Ctrl+Enter` で送信されない | `Ctrl+Enter: 送信ボタンが見つからず素通し` | 自己診断の `sendButton.via` が `none` なら `SEND_BUTTON_SELECTORS` に実 DOM のセレクタを追加 |
| 送信はされるが warn 付き | `名称一致（aria-label / title 等）で送信しました` | セレクタ配列が死んでいる。上記追加でフォールバックを外す |
| 変換確定直後だけおかしい | `compositionstart から N 秒経過` の warn | IME フラグ取りこぼし。入力欄外をクリック or ページ再読み込みで解消 |

### Enter の方針（strategy）

`stopPropagation()` は「同じノード・同じフェーズの後続リスナー」を止められない。
ChatGPT 側が `window` に keydown を登録していると、注入がページより後だと
そのハンドラが先に走って Enter が送信に使われてしまう。
v0.9では元のEnterイベントをShift+EnterとしてChatGPT自身に処理させる。
それでも負ける実装に備えて、方針を実行中に切り替えられる。

| 方針（`chatgptEnterKeyStrategy`） | 内容 |
| --- | --- |
| `remapToShiftEnter`（既定） | 元のEnterイベントをShift+EnterとしてChatGPTへ委任 |
| `stop` | `stopPropagation()` のみ（v0.3 まで。負けることがある） |
| `stopImmediate` | 同一ノードの後続も断つ。改行は既定動作に委任 |

切り替えはページのコンソールから（リロード不要、次の Enter から有効）:

```js
localStorage.setItem('chatgptEnterKeyStrategy', 'remapToShiftEnter');
```

どの方針が効いているかは自己診断の `config.strategy` に出る。
送信元の特定が必要なら、ページのコンソールで以下も有効（第 2 引数の `true` がキャプチャ）:

```js
getEventListeners(window).keydown;
getEventListeners(document).keydown;
getEventListeners(document.getElementById('prompt-textarea')).keydown;
```

## 5. 既知の弱点

- **DOM 依存**: `#prompt-textarea`、`#composer`、`data-testid="compose-send-button"` は ChatGPT の改版で変わると検出に失敗する。その場合 `Ctrl+Enter` は無害に素通しされ、`Enter` の改行化も効かないことがある。
- **イベント属性の変更に依存**: 既定方針は元のKeyboardEventの `shiftKey` を変更する。ChromiumやChatGPTが内部の修飾キー状態だけを参照する実装へ変わると効かなくなる可能性がある。その場合も変換失敗を検出できれば誤送信防止を優先する。
- **MAIN world**: ChatGPT本体と同じ実行環境で動くためイベント阻止は確実になるが、ページ側JavaScriptから拡張のグローバル診断関数が見える。機密情報や拡張APIは使用していない。
- **候補一覧との相互作用**: 既定方針ではEnterがShift+Enterとして見えるため、スラッシュコマンドや@言及の候補一覧でEnter決定できなくなる可能性がある。
- **改行チェックの誤検知**: 構造署名（`innerHTML.length` + `childElementCount`）で改行の反映を見るため、空段落の統合など DOM が変わらない改行では誤って warn することがある（実害はなく、`chatgptEnterKeyVerify = '0'` で止められる）。
- **生成中の `Ctrl+Enter`**: 送信ボタンが無効になるため基本は素通しだが、`aria-label` 名称一致のフォールバックが意図しないボタンに一致する理論余地がある。
- **`Cmd+Enter`**: macOS 対策として `Ctrl+Enter` と同扱い。Linux/Windows で Superキー併用も送信になる。
- **IME 猶予窓**: `compositionend` 後 100ms 以内の `Enter` は安全側で無視する。変換確定と送信を 0.1 秒未満で連続実行すると 1 回無視されることがある。
- **例外範囲**: 入力欄判定の否定条件に無い UI（ダイアログ内の一部 textarea 等）で誤介入する可能性がある。逆に、厳格化しすぎると新 UI で効かなくなる。
- **可視性判定の副作用**: 非表示 fallback を弾くのに `getClientRects()` / `checkVisibility()` を使っているため、描画されるがサイズ 0 の特殊な composer では判定が外れる可能性がある。
- **`Ctrl+Enter` の探索範囲**: 送信ボタンを「composerコンテナ → form → 最大6階層の近い祖先」の順で探す。さらに外側へ移動すると検出に失敗する（その場合は無害に素通し）。
- **ログの出力量**: 既定（`info`）ではページ読み込み時、入力欄 DOM の初回検出時、`Enter` 操作時に出力する。SPA が入力欄を作り直すと新要素をもう一度出す。入力テキスト・送信内容などの**内容は明示的には出力しない**が、DevTools に表示した DOM 要素を展開すると、その時点の子ノード（入力内容を含む場合がある）を確認できる。
- **警告ヒューリスティクス**: 「入力欄を特定できない」警告は 10 秒以内に 4 回 Enter を押した時だけ 1 回出す。検索欄・CodeMirror・非表示 fallback など明示的に除外した要素は数えないが、除外に含まれない contenteditable を連打すると誤警告しうる（実害はなく、再読み込みや正常な Enter で条件は解除される）。
- **testing**: 実際の DOM に対する自動テストは未実施（ブラウザ手動テストのみ）。

## 6. 補足

- `chrome://` / `vivaldi://` / 拡張のオプションページなどでは動作しない（MV3 の content_scripts 仕様）。
- 設定項目は意図的に無い。挙動を変えたい場合は `content.js` 冒頭の定数
  （`SEND_GUARD_MS` / `IME_GRACE_MS`）やセレクタ配列を直接編集する。
- セレクタが合わなくなったときは、ChatGPT 側の composer 付近を DevTools で複製して
  リポジトリルートの `docs/chatgpt-composer-dom.txt` に保存しておくと、
  入力欄・送信ボタンの候補を更新する足がかりになる。
  ※ DOM サンプルは「現時点の実装の参考」であり、将来も同一 DOM である前提にはしていない
  （生成 class 名・`aria-label` に依存しない設計にしてある）。
