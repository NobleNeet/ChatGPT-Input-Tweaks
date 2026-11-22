# ChatGPT Enter Key（Vivaldi / Chrome 互換拡張・Manifest V3）

ChatGPT の Chat モードと Work モードの入力欄で Enter キー挙動を変える拡張機能です。

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
├── manifest.json   # MV3 定義。content_scripts で chatgpt.com に content.js / nav.js を注入するだけ
├── content.js      # Enter キー系ロジック（入力欄判定 / IME 判定 / Enter・Ctrl+Enter 処理）
├── nav.js          # 右端の会話ナビゲーションバー（回答検出 / キャッシュ / ジャンプ / ハイライト）
└── README.md       # 本ファイル

docs/
└── chatgpt-dom-sample.txt          # 実 ChatGPT DOM の参考サンプル（判定の根拠にはしない）

tests/
├── composer-detection.test.mjs     # 入力欄判定の静的自動テスト（jsdom。§7）
└── nav-rail.test.mjs               # ナビバーの静的自動テスト（jsdom。§8）
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
- **送信後の composer 後始末**: `button.click()` は非可信クリックなので、ChatGPT 側の
  「Enter キー送信時に消える下書き」が消化されず composer に送信文本が残ることがあり、
  それが `Ctrl+Shift+O` の新規チャットに復元されてしまう。そこで `click()` から 500ms 後に
  composer を再チェックし、**送信内容与そのまま残っている場合のみ**こちらで空にして
  `input` イベントを発火させ、ページ側エディタ（ProseMirror 等）の更新フローで下書きも更新させる。
  ChatGPT 側が先に消していたり、ユーザーが別の入力を始めた後は触らない。
  無効化: `localStorage.setItem('chatgptEnterKeyClearAfterSend', '0')`。
- **入力欄の判定（イベント委譲）**: 要素参照は一切保持せず、毎回 `event.target`
  （またはその祖先）が ChatGPT の入力欄かを判定する。SPA で DOM が再生成されても成立する。
  - 実入力欄は `textarea` ではなく ProseMirror の `contenteditable="true"` div。
    判定は「編集可能か」＋「ChatGPT composer 固有の強い根拠」に分離している。
    - 編集可能: `isContentEditable`（`contenteditable`）
    - 強い根拠（いずれか 1 つ）: `id="prompt-textarea"` ／ composer コンテナ
      （Chat モードの `[data-chatgpt-composer]`、Work モードの `form[data-thread-find-composer="true"][data-composer-placement]`、または旧DOMの `#composer`・`[data-testid="composer"]`・`[data-test-id="composer"]`・`.composer-sender`）内部
      ／ 同一または近傍（実入力欄から上 2 階層・その容器から下 2 階層まで）の
      `name="prompt-textarea"` fallback
    - `role="textbox"` と `aria-multiline="true"` は**必須条件ではない**（補助シグナル）。
      改版でこれらの ARIA 属性が消えても実入力欄を検出し続けられる。
      逆に、ARIA 属性だけを根拠に受理する経路は無い ＝ 一般の
      `contenteditable="true" role="textbox" aria-multiline="true"` を無条件には対象にしない。
  - 否定条件: 非表示要素（`[hidden]`・`[aria-hidden="true"]`・`getClientRects()` 空・
    `checkVisibility()` false）、**`name="prompt-textarea"` の fallback `textarea`**、
    検索欄（`[role=searchbox]`・`input[type=search]`・`input[name=search]`）、
    コード編集域（CodeMirror / Monaco / `[role=code]`）、
    `password` / `number` / `tel` / `url` / `email` 等の別目的 input。
    これらは強い根拠があっても介入しない（除外が先に効く）。
  - 生成された class 名（`wcDTda_*` など）と `aria-label` は**入力欄判定に一切使わない**
    （`aria-label` は送信ボタン候補の最終フォールバックのみ）。
- **IME 対策**: `event.isComposing`、`event.keyCode === 229`、
  `compositionstart`〜`compositionend` の自前フラグ、
  および `compositionend` 直後 100ms の猶予窓（変換確定 Enter を拾わない）の 4 段構え。
- **不良検知ログ**: 操作結果を `console` に出す（`[ChatGPT Enter Key]` 接頭辞）。
  読み込み後に検出した入力欄の **DOM 要素そのもの**も自動表示する。
  SPA が入力欄を作り直した場合は、新しい要素を再度表示する。詳細は §4。

### 入力欄判定の受け入れ／拒否ケース

`isComposerInput()` は「編集可能か（`isContentEditableLike`）」と
「composer 固有の強い根拠（`hasStrongComposerIdentity`）」を分けて評価する。
ARIA 属性（`role="textbox"` / `aria-multiline="true"`）は補助シグナルで、判定の可否を変えない。

| DOM | 受理 | 理由 |
| --- | --- | --- |
| `<form data-chatgpt-composer><div contenteditable="true"></div></form>` | ○ | 現行構造。composer コンテナが強い根拠。ID・fallback・class・aria-label は不要 |
| `<form data-thread-find-composer="true" data-composer-placement="home"><div contenteditable="true"></div></form>` | ○ | Work モード。フォームが強い根拠。Chat モードの条件も継続して受理する |
| `<div id="prompt-textarea" contenteditable="true" role="textbox" aria-multiline="true">` | ○ | 旧構造。ID＋ARIA |
| `<div id="prompt-textarea" contenteditable="true">` | ○ | ARIA 属性が消えても ID が強い根拠 |
| `<div contenteditable="true" role="textbox" aria-multiline="true">`（composer コンテナ内部、または近傍に `name="prompt-textarea"` fallback） | ○ | 強い根拠がコンテナ／fallback |
| `<div contenteditable="true" role="textbox" aria-multiline="true">`（composer と無関係） | × | 強い根拠が無い一般編集域 |
| `<div contenteditable="true" role="textbox" aria-multiline="true" class="cm-content">` | × | CodeMirror は明示除外 |
| `<textarea name="prompt-textarea" style="display:none">` | × | 非表示 fallback は明示除外 |
| 検索欄（`[role=searchbox]` / `input[type=search]` / `input[name=search]`）、Canvas 内要素 | × | 明示除外／非描画 |

この矩阵は自動テストに落としてある（リポジトルートで `node tests/composer-detection.test.mjs`、
後述 §7）。実装側の変更に強い根拠を追加しない限り、ARIA 属性だけを対象に受理する経路は追加しないこと。

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
- [ ] `Ctrl+Enter` 送信後、送信文本が composer に残っていても約 0.5 秒後に空になる
      （ChatGPT 側が先に消した場合は追加動作しない／残った場合は `sendCleared` が増える）
- [ ] 送信後 0.5 秒以内に別の文章を入力し直した場合、後始末で消されない
- [ ] `Ctrl+Enter` を連打・長押ししても**二重送信されない**
- [ ] 入力が空のとき `Ctrl+Enter` を押しても何も起きない（送信ボタン無効のため素通し）
- [ ] `Alt+Enter` / `AltGr+Enter` で既存動作が変わらない
- [ ] 日本語入力: 「かんじ」→ `Enter`（変換確定）→ 変換が確定するだけで送信・改行されない
- [ ] 日本語入力: 変換確定直後の `Enter` / `Ctrl+Enter` が誤って横取りされない
- [ ] 日本語入力: 確定後に改行・送信をそれぞれ実行すると正しく動く
- [ ] 左サイドバーの検索欄で `Enter` を押しても拡張が影響しない（検索が従来どおり）
- [ ] DevTools で composer をinspectし、`form[data-chatgpt-composer]` 内の
      `div[contenteditable="true"]` だけが対象になる。旧DOMでは非表示の
      `textarea[name="prompt-textarea"]` に Enter が介入しない
- [ ] 新規チャット作成 / 履歴選択 / サイドバー折り返し後に **DOM が再生成されても**機能する
      （要素を保持していないことの確認）
- [ ] 生成中の `Enter` / `Ctrl+Enter` で Stop ボタンが誤って押されない
- [ ] Canvas / コード編集画面などの `Enter` が従来どおり（インデント・改行）
- [ ] `Enter` 改行が ChatGPT 側の状態に反映され、送信時に改行として届く
- [ ] `Ctrl+Z` などの Undo / Redo、ペースト後の改行が壊れない
- [ ] ページ遷移（新規チャット・履歴選択）後もそのまま機能する
- [ ] Console に `[ChatGPT Enter Key] v0.10.5 読み込み完了 (world=MAIN, run_at=document_start) ... Enter 方針=remapToShiftEnter` が 1 行だけ出ている（＝注入されている）
- [ ] `window.__chatgptEnterKeyProbe('form[data-chatgpt-composer] [contenteditable="true"]')` が
      `accepted: true`、`evidence.inComposerContainer: true` を返す
      （`evidence.promptId` と `evidence.promptFallbackNearby` は false でも受理される）
- [ ] 旧DOMの `window.__chatgptEnterKeyProbe('textarea[name="prompt-textarea"]')` は
      `accepted: false`（非表示 fallback には介入しない）
- [ ] Console に `ChatGPT の入力欄 DOM を検出しました:` と実際の contenteditable 要素が表示され、展開・inspect できる
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
特定要素だけが対象になっているかは `__chatgptEnterKeyProbe('form[data-chatgpt-composer] [contenteditable="true"]')` で、
受理可否とその内訳（`evidence`）がその場で確認できる。

### 「効かない」ときの読み方

| 症状 | ログの征兆 | 対応 |
| --- | --- | --- |
| そもそも効いていない | `v0.10.5 読み込み完了` が出ていない | 拡張カードの更新後、タブを完全に閉じて開き直す／拡張が有効か／`chatgpt.com` か |
| **`Enter` が送信される（ログは出ている）** | `remappedShiftKey` を確認 | `true` でなければイベント変更に失敗。誤送信防止の停止処理が働く |
| `Enter` で改行されない | `Enter` に対するログが 1 行も無い | 入力欄を特定できていない。自己診断で `accepted: false` ばかりなら `window.__chatgptEnterKeyProbe('form[data-chatgpt-composer] [contenteditable="true"]')` の `evidence` でどの根拠が消えているか確認し、`isComposerInput` の条件を更新 |
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
getEventListeners(document.querySelector('form[data-chatgpt-composer] [contenteditable="true"]')).keydown;
```

## 5. 既知の弱点

- **DOM 依存**: `[data-chatgpt-composer]`、新しい `form[data-thread-find-composer="true"][data-composer-placement]` と旧DOM用の `#prompt-textarea`・`#composer`、送信ボタンの候補属性が改版で変わると検出に失敗しうる。その場合 `Ctrl+Enter` は素通しされ、`Enter` の改行化も効かないことがある。
  入力欄判定は `role="textbox"` / `aria-multiline="true"` に依存していないが、
  強い根拠 3 系統（`id="prompt-textarea"`／composer コンテナ／近傍の `name="prompt-textarea"` fallback）が
  同時に消えると検出できない。その場合は自己診断の `composerEvidence` が全て `false` になる。
  「近傍」には上限（実入力欄から上 2 階層・その容器から下 2 階層）を置いていて、
  body / html まで遡ると本文側の別編集域が composer の fallback を誤って拾ってしまうため
  （上限を緩めると誤検知、厳しくすると改版で fallback ルートが落ちる）。
- **イベント属性の変更に依存**: 既定方針は元のKeyboardEventの `shiftKey` を変更する。ChromiumやChatGPTが内部の修飾キー状態だけを参照する実装へ変わると効かなくなる可能性がある。その場合も変換失敗を検出できれば誤送信防止を優先する。
- **MAIN world**: ChatGPT本体と同じ実行環境で動くためイベント阻止は確実になるが、ページ側JavaScriptから拡張のグローバル診断関数が見える。機密情報や拡張APIは使用していない。
- **候補一覧との相互作用**: 既定方針ではEnterがShift+Enterとして見えるため、スラッシュコマンドや@言及の候補一覧でEnter決定できなくなる可能性がある。
- **改行チェックの誤検知**: 構造署名（`innerHTML.length` + `childElementCount`）で改行の反映を見るため、空段落の統合など DOM が変わらない改行では誤って warn することがある（実害はなく、`chatgptEnterKeyVerify = '0'` で止められる）。
- **生成中の `Ctrl+Enter`**: 送信ボタンが無効になるため基本は素通しだが、`aria-label` 名称一致のフォールバックが意図しないボタンに一致する理論余地がある。
- **送信後後始末の誤消し余地**: 送信直後 500ms 以内に、送信したものと**完全に同一の文**を
  再入力した場合のみ、後始末で誤って消える理論余地がある（同一内容の即時再入力は稀なため許容）。
  実害が出たら `chatgptEnterKeyClearAfterSend = '0'` で無効化できる。
- **`Cmd+Enter`**: macOS 対策として `Ctrl+Enter` と同扱い。Linux/Windows で Superキー併用も送信になる。
- **IME 猶予窓**: `compositionend` 後 100ms 以内の `Enter` は安全側で無視する。変換確定と送信を 0.1 秒未満で連続実行すると 1 回無視されることがある。
- **例外範囲**: 入力欄判定の否定条件に無い UI（ダイアログ内の一部 textarea 等）で誤介入する可能性がある。逆に、厳格化しすぎると新 UI で効かなくなる。
- **可視性判定の副作用**: 非表示 fallback を弾くのに `getClientRects()` / `checkVisibility()` を使っているため、描画されるがサイズ 0 の特殊な composer では判定が外れる可能性がある。
- **`Ctrl+Enter` の探索範囲**: 送信ボタンを「composerコンテナ → form → 最大6階層の近い祖先」の順で探す。さらに外側へ移動すると検出に失敗する（その場合は無害に素通し）。
- **ログの出力量**: 既定（`info`）ではページ読み込み時、入力欄 DOM の初回検出時、`Enter` 操作時に出力する。SPA が入力欄を作り直すと新要素をもう一度出す。入力テキスト・送信内容などの**内容は明示的には出力しない**が、DevTools に表示した DOM 要素を展開すると、その時点の子ノード（入力内容を含む場合がある）を確認できる。
- **警告ヒューリスティクス**: 「入力欄を特定できない」警告は 10 秒以内に 4 回 Enter を押した時だけ 1 回出す。検索欄・CodeMirror・非表示 fallback など明示的に除外した要素は数えないが、除外に含まれない contenteditable を連打すると誤警告しうる（実害はなく、再読み込みや正常な Enter で条件は解除される）。
- **testing**: 入力欄判定ロジックの静的自動テストは `tests/composer-detection.test.mjs`（jsdom）。
  実際の ChatGPT DOM・実キー入力に対するブラウザ自動テストは未実施（§3 の手動 GUI テストのみ）。

## 6. 補足

- `chrome://` / `vivaldi://` / 拡張のオプションページなどでは動作しない（MV3 の content_scripts 仕様）。
- 設定項目は意図的に無い。挙動を変えたい場合は `content.js` 冒頭の定数
  （`SEND_GUARD_MS` / `IME_GRACE_MS`）やセレクタ配列を直接編集する。
- セレクタが合わなくなったときは、ChatGPT 側の composer 付近を DevTools で複製して
  リポジトリルートの `docs/chatgpt-dom-sample.txt` に保存しておくと、
  入力欄・送信ボタンの候補を更新する足がかりになる。
  ※ DOM サンプルは「現時点の実装の参考」であり、将来も同一 DOM である前提にはしていない
  （生成 class 名・`aria-label`・`role` / `aria-multiline` に依存しない設計にしてある）。

## 7. 入力欄判定の自動テスト（静的）

実ブラウザを使わず、判定ロジックだけを jsdom 上で検証する。

```sh
npm install          # devDependency: jsdom のみ
npm test             # = node tests/composer-detection.test.mjs
```

`tests/composer-detection.test.mjs` は `chatgpt-enter-key/content.js` をそのまま jsdom に
読み込み、`window.__chatgptEnterKeyProbe()` 経由で次の受け入れ／拒否矩阵を確かめる
（§1 の表と同じケース集合＋ ARIA 属性の有無を振った差分）。

- 受理: 現行構造／`role`・`aria-multiline` を消した将来構造／composer コンテナ内部／
  近傍に `name="prompt-textarea"` fallback／旧 textarea 構成（可視＋送信ボタンのある form）
- 拒否: 非表示 fallback／CodeMirror・Monaco・`[role=code]`／検索欄／`aria-hidden`・非表示／
  `password` 等の別目的 input／Canvas／composer と無関係な `contenteditable`（ARIA 属性があっても）
- その他: ARIA 属性の有無で合否が変わらないこと、自己診断が投げずに `composerEvidence` を返すこと、
  判定処理自体がコンソールログを増やさないこと、Ctrl/Cmd+Enter・Enter・Shift+Enter・IME 中の挙動、`content.js` の `VERSION` が `manifest.json` と一致すること

jsdom に `isContentEditable` と `getClientRects()` の実装が無いため、テスト側でブラウザの挙動を
再現している（`content.js` 側は触らない）。キーイベントの委譲も jsdom で検査する。
実 ChatGPT DOM とブラウザでの改行・送信結果は §3 の手動テストで確認すること。

## 8. 会話ナビゲーションバー（nav.js）

画面右端の上部に、各 ChatGPT 回答に対応する短い横線を縦に並べる固定バーを表示する。
旧公式 UI の会話ナビゲーションに相当する機能で、**非公開 API は使わず DOM の観察だけ**で実装している。

### 動作

| 要素 | 挙動 |
| --- | --- |
| 横線（マーカー） | 回答 1 件につき 1 本。会話内の回答順に等間隔。クリック領域は線の見た目より広い（22px 幅の行） |
| クリック（DOM 在位） | 実測位置からヘッダーオフセットを引いた地点へ `smooth` スクロール |
| クリック（キャッシュのみ） | 記録済み位置へ `auto` で飛び、仮想スクロールの再描画を監視。再出現した実要素へ **1 回だけ**補正。再描画が来なければ時間切れで打ち切り（無限リトライしない） |
| 通常グレー | 回答が DOM に存在（opacity 0.7） |
| 薄いグレー | キャッシュのみ＝仮想化で DOM から消えている（opacity 0.3）。マーカーは消さない |
| 青色・長め | 表示領域上部の基準線を最後に通過した回答（現在位置）。在 DOM 状態より優先（opacity 1.0） |
| ホバー | 回答本文の冒頭（約 180 字）をツールチップ表示 |
| 多量回答 | バー高を画面内（72vh）に収め、間隔縮小 → 最小でも収まらなければバー内スクロール |
| テーマ | ライト／ダーク（`html.dark` クラス基準。OS `prefers-color-scheme` もフォールバック） |

### 仮想スクロール対応の設計

- 検出単位は `h4[data-conversation-role="assistant"]` の**親要素（回答コンテナ）**。
  識別キーは `data-turn-key` + `data-response-body`（messageId）で、同一ターン内の複数回答も区別する。
- 検出した回答はメモリ内キャッシュに保持（`turnKey / messageId / preview / scrollPosition /
  relativePosition / lastSeen / inDOM`）。DOM 要素参照はvolatile な再取得用で、識別には使わない。
- 仮想化で消えた回答は `inDOM=false` にして**保持**。再次出現で `inDOM=true` に戻る。
  削除は「同一ターンが DOM に残っているのに当該回答だけ存在しない」
  ＝編集・再生成・分岐変更で置き換えられた場合のみ（単なる非描画を削除根拠にしない）。
- 並び順は「今回 DOM で観察できた前後の既知回答」優先で挿入。前後不明時のみスクロール位置を補助に使う。
- 未描画（一度も DOM に出ていない）回答の件数・ID は推測しない。
  会話をスクロールして閲覧すると検出済みマーカーが徐々に増えていく。
- 会話切り替え（URL の `/c/<id>`）でキャッシュを全消去。新規チャットの ID 未確定→確定は同一会話として adopt。
- `MutationObserver` は transcript を監視し、変更は 180ms 合流でまとめて再スキャン。
  ナビ UI 自身の mutation はスキップする。回答生成中も「構造シグネチャ（キー順+在DOM状態）不変なら
  DOM 組み替えなし」でフィードバックループを断つ。位置更新とハイライトは rAF で間引く。
- ジャンプ中は wheel / touch / PageUp 等の手動入力で自動補正を中断し、ユーザー操作を優先する。
- **UI イベントガード**（v0.10.2）: バー上の pointer/click 系イベントを
  window キャプチャ段（document_start でページ本体より先に登録）で止める。
  これをしないと ChatGPT の「アプリ内クリック→composer 再フォーカス→
  最新へスクロール」に拾われ、**ジャンプ直後に会話最下部へ引き戻される**。
  - mousedown / pointerdown(mouse) は preventDefault でフォーカス強奪を防止
  - touchstart/touchend は preventDefault しない（合成クリックが消えるため）
  - クリック自体はガード内で `onRowClick()` に渡すのでジャンプは従来どおり
  - バー外（ChatGPT 本来の UI）のイベントには一切干渉しない
- **最下部拉致（ひきつけ）検知・再発射**（v0.10.2 保険）: ジャンプ発射から 60ms〜1.2s の窓で、
  「目標より 1ビューポート以上下の最下部に吸着している」場合は目標へ1回だけ再発射する。
  利用者の手動入力は `cancelJump()` で打ち消すため、無操作のときだけ動作する。
- **合成意図ホイール**（v0.10.3）: v0.10.2 でも「冒頭へ飛ぶ→最下部へ戻る」が
  往復する症状が残った。原因はクリックの伝播ではなく**我々のプログラム的スクロール
  自体**が ChatGPT の「最新への自動追従」に意図なしと判定され直後に最下部へ
  引き戻されること。そこでジャンプ発射前後で `deltaY=±2` の微小 wheel を
  合成発射し「利用者のスクロール意図」を伝える（`debug` ログ: `send user scroll intent`）。
  - ジャンプ中は 120ms 間隔・発射から 700ms 窓で間欠発射（checkJump が pump）
  - 方向は実際の移動方向と一致（下ジャンプ＝deltaY>0、上ジャンプ＝deltaY<0）。
    v0.10.4 までは「原則上方向（離脱）」だったが、嘘の方向は ChatGPT の
    ホイール処理と喧嘩して下方向ジャンプが潰れるため v0.10.5 で一致式に変更
  - イベントには `__cnavIntent` マークを付け、我々自身の wheel 中断では打ち消さない
  - 再発射（re-assert）は可視の反動が少ない `auto`（即時着地）に変更
- **飲み込み（Pin）自動検知・再発射**（v0.10.4）: 実機で「1回目はスクロールが
  全く発火せず、2回目のクリックで飛ぶ」症状が確認された。最初のプログラム的
  スクロールが ChatGPT 側の Scroll Pin に無効化されるためと見られる。
  そこでジャンプ発射から 250ms 経っても scrollTop が発射直前の位置から
  4px 以上動いていなければ「未実行」とみなし、意図ホイールを添えて
  1 回だけ auto（即時）で再発射する（无限リトライ禁止・拉致保険と 1 回上限を共有）。
  - 検知時は既定レベル（warn）で `jump が未実行のようだと検知…再発射` と出る
  - 実際のスクロールは 250ms 以内に着地/進行するため誤検知しにくい
  - 絶対位置（scrollPosition）が欠けたキャッシュは relativePosition×scrollHeight
    で推定ジャンプ（暫定値。再出現後の実測補正が本体）
  - 飲み込みで scroll イベントが発生しなくても回るよう、jumpTo 自身が
    rAF ループ（checkJump の運転手）を起動する
- **trusted 入力限定の中断**（v0.10.5）: 実機で「上方向ジャンプは効くが、
  上の方を閲覧中に下方向のマーカーをクリックするとスクロール自体が
  起きない」症状が確認された。ChatGPT は入れ子スクローラからホイールを
  再ディスパッチ（転送）することがあり、その untrusted イベントが
  「マークなしのユーザー操作」として我々の中断リスナーに刺さり、
  ジャンプ開始直後に自分自身で中断していたためと見られる。
  - wheel/touchstart での中断は `isTrusted` の本物の入力だけ採用
    （利用者の実ホイール／タッチでの中断要件はそのまま成立）
  - `__cnavIntent` マーク付きイベントは従来どおり無視
  - デバッグ/検証: `__chatgptNav.internals.setTrustedOnlyCancel(false)`
    で合成ホイールも中断扱いにできる（jsdom では trusted を作れないため、
    テストはこのスイッチで「wheel＝中断」挙動を検証）
- **スクローラ自己検証と scrollIntoView フォールバック**（v0.10.6）:
  「スクロールが一切起きない」残りの原因として、我々が選ぶスクロール
  コンテナの誤認（React 再マウントで stale / overflow 要素違い）を潰す。
  - jumpTo 時に cached scroller が detached なら再解決。スクロール不能要素ならログ
  - stuck 再発射で `scrollTo` がページを動かせなかった場合のみ、
    在位回答要素に対して `scrollIntoView({behavior:'auto'})` を試行
    （ブラウザがスクローラ自体を探しに行くのでコンテナ誤認に強い）
  - 全工程をリングログに記録（上の「診断」参照）
- **stall 検知・LIVE 実測補正（v0.10.7・根本原因）**:
  実機リングログで真因が確定した。上方向ジャンプ中、スクロールは
  正常に動き始めていたが（14750→…→10815）、途中で ChatGPT の仮想化
  reflow が走りスクロールコンテナ高が 16072→13004 に変化。上部の
  座標系ごとシフトして発射時に保存した target（9420）が無意味化し、
  smooth アニメーションは 7646 で死亡 → 目的回答を通り越して止まる。
  下方向「無反応」も同型（発射直後に reflow でアニメが死に、
  「発射位置から ≤4px」の stuck 条件をちょうど外れて放置されていた）。
  - 対策：smooth 中に 220ms 以上ピクリとも動かない & 未着地を
    「停滞」とみなし、**保存済み target を捨てて LIVE の DOM 実測**
    （resolveLiveContainer の現在 rect）から auto で補正する
  - stall 補正の直後は停滞タイマーもリセット（approx 補正→smooth 継承時
    の誤発火防止）
  - 検知時は warn レベルで `jump が途中で停滞…LIVE 実測へ補正` を出力
- **補正予算・rel re-aim（v0.10.8）**:
  実機ログ（cache-only→補正→再 reflow）で「reflow は 1 回で終わらない」
  ことが判明：補正 smooth の走行中に ChatGPT がさらに追加ターンを
  レンダリングして座標が再帰的にshift し、単発の stallFixed だと
  「LIVE 要素が見つからない」で予算を使い切りタイムアウトした。
  - 補正は `JUMP_MAX_FIXES = 3` の**予算式**に変更（LIVE 実測 auto が
    最大 3 発。無限リトライ禁止は維持）
  - stall 中に LIVE 要素が不在のときは、キャッシュの relativePosition
    × 現在の maxScroll で **1 回だけ rel re-aim**（絶対位置は reflow で
    死んでいるが相対割合は有効、という前提）し、approx に戻って
    再描画を待つ。再出現後は auto 補正で着地
  - approx→実測補正も smooth ではなく **auto（即時）** に変更。
    smooth 走行窗の間に reflow が入ると座標が壊れるため、即時着地が
    最も事故が少ない
  - 毎 tick で scrollHeight の変化を `jump sh changed Δ=…` として記録。
    stall 失敗時は `probeLive`（turnKey が DOM に在るか／response-body
    在否／現在レンダリング中の turnKey 一覧）をログに出すので、
    「どこに DOM ウィンドウがあるのに目的が居ないのか」が唯一定位できる
  - jumpState() は `fixes`（消費予算）/ `reaimed` も返す
- **会話順アンカー再推定・hill-climb re-aim（v0.10.9・真因対策）**:
  v0.10.8 の rel re-aim は実機で失敗した（「上方向は成功、そこから
  下方向は失敗」）。実測で **cached な絶対位置も relativePosition も
  仮想化の崩壊フレームではどちらも壊れる**ことが確定：上方 culling で
  `abs' = abs − Δ; sh' = sh − Δ` のため rel まで変わる（同一 turn が
  sh=13004 で rel≈0.50、崩壊後 sh=7607 で rel=0.14 等）。
  仮想化で崩れない不変条件は ①ターン自高（data-virtualized-turn の
  offsetHeight）②items[] の会話順 ③「レンダリング済みブロックは
  画面に居る」こと。**この3点だけで目標位置を再推定する**方式に変更：
  - scan 時に `turnHeights`（turnKey→ターン自高）をキャッシュ
  - `guessAbsFromRendered()`: 現在 DOM に在る回答の turn 実測位置を
    アンカーに、会話順の差分（ターン自高＋間隔 TURN_GAP_PX の積み上げ、
    未知の高さは平均でごまかさず null）で目標の絶対位置を算出
  - `tryGuessReaim()`：目標が未レンダリング（approx）/ stall 中に LIVE
    要素不在のとき、500ms クールダウン・**guesses 最大 5（fixes と別枠）**
    でアンカー推定→auto 発射→approx 復帰を繰り返し、reflow を追跡する。
    材料がアンカーのみで推定できない時だけ従来通り rel×max にフォールバック
  - jumpTo（cache-only）の初期 base も `anchor > pos > rel` の優先順で選ぶ
    （`baseSrc=anchor|pos|rel` をログに出す）
  - 追跡ログ強化：`src=rendered-anchor|rel`、`guess#N`、tick の `g=`、
    `baseSrc=`、keep-wait 時の `probeLive`（レンダリング中 turnKey 一覧）
  - jumpState() に `guesses` を追加

### 手動テスト項目（nav）

- [ ] 会話画面の右端上部に横線が縦に並び、回答数と一致する（スクロールして閲覧すると増えていく）
- [ ] 横線をクリックすると該当回答の冒頭へ移動する（固定ヘッダーに埋もれない）
- [ ] 横線クリック後、**最下部へ引き戻されずにそのまま留まる**（v0.10.3 の
      合成意図ホイールが効いていることの確認。反動が起きたら `debug` ログを見る）
- [ ] 会話を上下スクロールすると現在位置の横線が青色（長く）になる
- [ ] 上方にスクロールして回答が仮想化で消えると、そのマーカーは薄いグレーで**残る**
- [ ] 薄いグレー（キャッシュのみ）のマーカーをクリックすると、記録位置へ飛んでから
      該当回答の冒頭へ補正される（補正は最大 1 回）
- [ ] 補正待ちの最中にホイールで操作すると自動補正が止まり、手動操作が優先される
- [ ] 回答生成中（本文が伸びている間）もバーが暴れず、既存の横線はそのまま、新しい回答が末尾に増える
- [ ] 別会話へ切り替えるとマーカーが全入れ替わり、前会話のが混在しない
- [ ] 新規チャットで最初の送信後 URL が /c/<id> になっても検出済みマーカーが消えない
- [ ] 回答の再生成後、置き換えられた旧マーカーが消え新回答のマーカーになる
- [ ] ライト／ダーク両モードで背景に馴染み、入力欄・スクロールバー・ボタンを妨げない
- [ ] 長い会話（多数の回答）でもカクつき・CPU 高騰がない（DevTools Performance で確認）
- [ ] `document.body` に `#cnav-root` / `#cnav-bar` があり、transcript の外側で
      MutationObserver の再発火要因になっていない

### 診断

- **リングログ（v0.10.6〜）**: ログレベルに関係なく直近 300 件のイベントを常に記録。
  不具合再現後にコンソールで:
  ```js
  copy(__chatgptNav.log())   // 全文がクリップボードへ
  __chatgptNav.log()         // 文字列で返すだけ
  __chatgptNav.clearLog()    // リングを空にする
  ```
  クリック→ジャンプ→中断/着地/打ち切りまでが `[+経過ms] イベント 詳細` で並ぶ。
  記録されるもの: UI 上のクリック、ジャンプ開始（scroller/現在位置/目標）、
  jump tick（50ms 間隔で現在位置と目標の推移）、wheel/touch の混入
  （trusted/marked 判定も）、scroll イベント、stuck 検知・再発射、
  拉致検知、完了/タイムアウト/キャンセル理由、scan 中の対象状態。
  **「飛まない」が起きたらこのログ paste 一発で原因が特定できる。**
- `window.__chatgptNav.snapshot()` … 会話ID・アクティブキー・キャッシュ済み回答一覧
- `window.__chatgptNav.jumpState()` … ジャンプ中状態（`null` なら待機）。
  `startScroll`（発射直前の位置）/ `reasserted`（再発射済みか）も含む
- `window.__chatgptNav.jumpTo(key)` … プログラムからジャンプ（成否 boolean）
- ログ: `localStorage.setItem('chatgptNavLogLevel', 'debug')`（既定 `warn` ＝ジャンプ失敗等の警告のみ表示 / `off` で無音）
  - マーカークリック→ジャンプ開始・補正・打ち切りは `debug` で1行ずつ確認できる
  - ジャンプ失敗（クロールコンテナ不明・位置未記録・古い行）は既定の `warn` で `[ChatGPT Nav]` 付き出る

### 自動テスト（静的）

```sh
npm install
npm test   # = composer-detection.test.mjs && nav-rail.test.mjs
```

`tests/nav-rail.test.mjs` は jsdom 上に spec 相当の仮想化 DOM を組み、
`window.__chatgptNav` 経由で以下を検証する（レイアウト系はスタブ再現）。

- 検出: 見出しの親＝回答コンテナ単位・キー（turnKey\|messageId）・プレビュー
- キャッシュ: 仮想化消失で inDOM=false・再出現で true・`.off` クラスの濃淡
- 並び順: 後から上に現れた回答が DOM 前後関係どおり前挿入され、再スキャンで崩れない
- 削除: ターン残存で回答のみ消えたら破棄／ターンごと消えたら保持
- 会話切り替え: 全消去、および null→ID の adopt
- 位置: scrollPosition / relativePosition の記録
- ジャンプ: inDOM=smooth／cache-only=approx→再出現後 1 回だけ補正→完了解除／
  再描画なしは時間切れ打ち切り／wheel・PageDown で中断／失敗キーは false
- ハイライト: 基準線最終通過回答が `.cur`／全回答が基準線下なら非表示（誤強調しない）
- 描画: 構造不変なら行を生成し直さない（回答生成中のループ防止）
