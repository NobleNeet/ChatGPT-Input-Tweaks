/**
 * ChatGPT 入力欄の Enter キー挙動を変えるだけの最小スクリプト（content script）
 *
 *   Enter              ... 改行（送信しない）
 *   Shift+Enter        ... 改行（既定動作。干渉しない）
 *   Ctrl+Enter         ... 送信
 *   Cmd+Enter          ... 送信（macOS 向け。Ctrl+Enter と同義）
 *   Alt+Enter          ... 何もしない（通常入力を妨げない）
 *   IME 変換中の Enter ... 絶対に何もしない
 *
 * 設計メモ
 *   - keydown は window のキャプチャ段（document より上流＝最も早い段）で受け取り、
 *     event.target から都度「ChatGPT の入力欄か？」を判定する委譲方式。
 *     SPA で DOM が再生成されるため、要素参照は一切保持しない。
 *   - 「Enter で改行」は preventDefault() で既定動作を止めるのではなく、
 *     stopPropagation() で ChatGPT 本体の送信ハンドラにだけ到達させ、
 *     ブラウザ／エディタ自身の改行処理（DOM 更新）を使いきる。
 *     → innerHTML の書き換えや合成イベントの偽造は行わない。
 *   - 「Ctrl+Enter で送信」は KeyboardEvent を作り直して再発行しない。
 *     送信ボタン要素を見つけて click() する。
 *   - 送信ボタンが見つからない場合はイベントを素通しする（暴走防止）。
 *   - 入力欄は textarea ではなく ProseMirror の contenteditable div。
 *     生成された class 名（wcDTda_* 等）と aria-label には依存しない。
 */
(() => {
  'use strict';

  // 同一フレームでの二重注入だけ防御する（それ以外の状態は持たない）
  if (window.__chatgptEnterKeyLoaded) return;
  window.__chatgptEnterKeyLoaded = true;

  // ---- 定数 ------------------------------------------------------------

  // Ctrl+Enter の二重送信（長押し・連続押下）を抑止する時間 [ms]
  const SEND_GUARD_MS = 400;

  // compositionend 直後の Enter を「変換確定用の Enter」として扱う猶予 [ms]
  const IME_GRACE_MS = 100;

  // 改行を持ち得る編集域の種別（input[type=search] 等は後続の除外条件で弾く）
  const TEXT_INPUT_TYPES = new Set(['text']);

  // composer 全体を指し得るコンテナ候補（バージョン差分対策）
  const COMPOSER_CONTAINER_SELECTOR = [
    '#composer',
    '[data-testid="composer"]',
    '[data-test-id="composer"]',
    '.composer-sender',
  ].join(', ');

  // 誤検知してはいけない入力 UI（検索欄・コードエディタ・非表示 fallback など）
  const EXCLUDED_SELECTOR = [
    // 非表示の fallback textarea（実入力欄と同じ親要素に置かれる）
    'textarea[name="prompt-textarea"]',
    'input[name="prompt-textarea"]',
    '[aria-hidden="true"]',
    '[hidden]',
    // 検索欄系
    '[role="searchbox"]',
    '[role="search"]',
    'input[type="search"]',
    'input[name="search"]',
    // コード編集系（Enter はエディタ側に解釈してもらう）
    '[role="code"]',
    '.cm-content',
    '.cm-editor',
    '.monaco-editor',
    // 改行を持てない / 別目的のコントロール
    'input[type="password"]',
    'input[type="number"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="email"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'select',
  ].join(', ');

  // 送信ボタンの候補（上から順に評価）。shadow DOM 配下やカスタム要素も一応視野。
  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="compose-send-button"]',
    'button[data-test-id="compose-send-button"]',
    'button[data-testid="send-button"]',
    'button[data-test-id="send-button"]',
    '#micro-app-send-btn',
    '#micro-app-send-btn button',
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="送信"]',
  ];

  // 候補に無かった場合の最終フォールバックで許す名称（"Stop" 等を誤クリックしないため）
  const SEND_NAME_RE = /send|submit|送信/i;

  // ---- IME 状態 ------------------------------------------------------------

  let isComposingNow = false;
  let compositionEndedAt = -Infinity;

  // 入力欄の判定より先に調べる（IME 中は常に素通しが最優先）
  function isImeActive(event) {
    if (event.isComposing === true) return true;
    if (event.keyCode === 229) return true; // 仕様上 / 一部 IME の変換中コード
    if (isComposingNow) return true; // compositionstart ~ compositionend 間
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
    return now - compositionEndedAt < IME_GRACE_MS;
  }

  // ---- 入力欄の判定 --------------------------------------------------------
  //
  // 実 DOM（docs/chatgpt-composer-dom.txt 参照）では入力欄は
  //   <div id="prompt-textarea" contenteditable="true" role="textbox"
  //        aria-multiline="true" class="ProseMirror ...">
  // で、textarea ではない。同じ親には name="prompt-textarea" の
  // 非表示 fallback textarea があり、それは対象にしない。
  //
  // 判定はすべて event.target から都度行う（SPA で DOM が再生成されるため
  // 要素参照を保持しない）。生成された class 名（wcDTda_* 等）と aria-label は
  // 判定に使わない。

  // keydown の target は編集域そのものか、その内部要素になり得る。外側へ探す。
  function findEditableAncestor(node) {
    if (!(node instanceof Element)) return null;
    const byAttr = node.closest('textarea, input, [contenteditable="true"]');
    if (byAttr) return byAttr;
    return node.isContentEditable ? node : null; // 属性表現を拾えない contenteditable 対策
  }

  // ChatGPT の composer 内部かどうか
  function isInsideComposer(el) {
    return Boolean(el.closest(COMPOSER_CONTAINER_SELECTOR));
  }

  // 描画されているか。非表示 fallback textarea を実入力欄と取り違えないための歯止め。
  function isRendered(el) {
    if (el.hidden === true) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.style && el.style.display === 'none') return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) {
      return false; // display:none / 未接続
    }
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      return false;
    }
    return true;
  }

  // 現行 ProseMirror composer の特徴量（生成 class には依存しない）
  function looksLikeRichComposer(el) {
    return (
      el.isContentEditable === true &&
      el.getAttribute('role') === 'textbox' &&
      el.getAttribute('aria-multiline') === 'true'
    );
  }

  // この編集域へ Enter を介入してよいか否か
  function isComposerInput(el) {
    if (!el) return false;
    if (el.disabled === true) return false;
    if (!isRendered(el)) return false; // 非表示 fallback textarea 等はここで弾く

    const tag = el.tagName.toLowerCase();
    const isTextControl =
      tag === 'textarea' ||
      (tag === 'input' && TEXT_INPUT_TYPES.has(el.getAttribute('type') || 'text'));
    const isRich = el.isContentEditable === true;
    if (!isTextControl && !isRich) return false;

    // 明示的に除外（自分自身および祖先を含む）
    if (el.matches(EXCLUDED_SELECTOR) || el.closest(EXCLUDED_SELECTOR)) return false;

    // 肯定条件 1: 本命 ID。改版で role / aria-multiline が消えても効くようにする。
    // tag 実体（contenteditable div）であることを条件に含め、同名の fallback を寄せ付けない。
    if (el.id === 'prompt-textarea' && looksLikeRichComposer(el)) return true;

    // 肯定条件 2: contenteditable + role=textbox + aria-multiline=true（現行構成）
    if (looksLikeRichComposer(el)) return true;

    // 肯定条件 3: composer コンテナ配下の rich editable（非 rich は fallback の可能性）
    if (isRich && isInsideComposer(el)) return true;

    // 肯定条件 4: 旧 textarea 構成向け。可視かつ「送信らしきボタンのある form」に限る
    if (isTextControl) {
      const scope = el.closest('form') || (isInsideComposer(el) ? el.parentElement : null);
      return Boolean(scope) && findSendButton(scope) !== null;
    }
    return false;
  }

  // Ctrl+Enter の送信対象を辿るスコープ。
  // rich editor（contenteditable）は form でラップされていないことが多く、
  // form まで落とすと本文全体が scope 化して誤ヒットするため、
  // 「composer コンテナ → 直近の親」の順に狭い範囲だけを探す。
  function composerScopeOf(el) {
    if (el.isContentEditable === true) {
      return el.closest(COMPOSER_CONTAINER_SELECTOR) || el.parentElement || null;
    }
    return (
      el.closest(COMPOSER_CONTAINER_SELECTOR) ||
      el.closest('form') ||
      el.parentElement ||
      null
    );
  }

  // ---- 送信ボタン ----------------------------------------------------------

  function isEnabledButton(btn) {
    if (!btn || btn.disabled === true) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (
      typeof btn.checkVisibility === 'function' &&
      !btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      return false; // 生成中などで描画されていない
    }
    return true;
  }

  function labelOf(btn) {
    return [
      btn.getAttribute('aria-label'),
      btn.getAttribute('title'),
      btn.dataset.testid,
      btn.dataset.testId,
      btn.id,
    ]
      .filter(Boolean)
      .join(' ');
  }

  function findSendButton(scope) {
    if (!scope) return null;

    for (const selector of SEND_BUTTON_SELECTORS) {
      let node = null;
      try {
        node = scope.querySelector(selector);
      } catch (_) {
        continue; // 将来の DOM 用 selector が構文エラーでも続行
      }
      if (!node) continue;
      // カスタム要素 / 内部 button の両方を許す
      const btn =
        node.tagName === 'BUTTON' || node.matches('[role="button"]')
          ? node
          : node.closest('button, [role="button"]') ||
            node.querySelector('button, [role="button"]');
      if (isEnabledButton(btn)) return btn;
    }

    // 名称一致に限定した最終フォールバック
    const buttons = Array.from(scope.querySelectorAll('button')).filter(isEnabledButton);
    return buttons.find((btn) => SEND_NAME_RE.test(labelOf(btn))) || null;
  }

  let lastSendAt = -Infinity;

  function sendWith(button, event) {
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : Date.now();
    // 連打・キーリピートによる二重送信を防ぐ
    if (now - lastSendAt < SEND_GUARD_MS) return;
    lastSendAt = now;

    // ChatGPT 側に Enter を渡さず、既定の改行挿入も止めてから click() する
    event.preventDefault();
    event.stopPropagation();
    button.click();
  }

  // ---- keydown ハンドラ ---------------------------------------------------

  function handleKeyDown(event) {
    if (event.key !== 'Enter') return;
    if (event.defaultPrevented === true) return;

    const editable = findEditableAncestor(event.target);
    if (!editable || !isComposerInput(editable)) return; // 入力欄以外は無関係

    // IME 変換中（およびその直後）は絶対に触らない
    if (isImeActive(event)) return;

    // Alt（AltGraph 含む）が混ざるものは原則として素通し
    if (event.altKey) return;

    // Ctrl+Enter / Cmd+Enter: 送信ボタンを見つけて click()
    if (event.ctrlKey || event.metaKey) {
      const button = findSendButton(composerScopeOf(editable));
      if (button) sendWith(button, event);
      return; // 見つからなければ素通し
    }

    // Shift+Enter: ChatGPT 側の既定動作（改行）に任せる
    if (event.shiftKey) return;

    // Enter 単独: 送信ハンドラにだけ到達させない。既定の改行はそのまま働かせる。
    if (editable.tagName.toLowerCase() === 'input') {
      // 1 行 input の既定 Enter は form 送信になるため、それだけ止める（改行は不可）
      event.preventDefault();
    }
    event.stopPropagation();
  }

  // ---- 登録 ---------------------------------------------------------------

  // compositionstart / compositionend は capture で受ける（どちらで届いても対応）
  window.addEventListener(
    'compositionstart',
    () => {
      isComposingNow = true;
    },
    true
  );

  window.addEventListener(
    'compositionend',
    (event) => {
      isComposingNow = false;
      compositionEndedAt = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
    },
    true
  );

  // 編集域が失効した際に IME フラグを固定しない（取りこぼし対策）
  window.addEventListener(
    'blur',
    () => {
      isComposingNow = false;
    },
    true
  );

  // window のキャプチャ段 = ChatGPT 本体（React のルート委譲）より先に立てる位置
  window.addEventListener('keydown', handleKeyDown, true);
})();
