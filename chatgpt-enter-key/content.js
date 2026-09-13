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
 *   - 不良検知用のログを出す（既定 info / localStorage 'chatgptEnterKeyLogLevel' で切替）。
 *     通常タイピングでは無出力。入力内容そのものは出力しない。
 *     自己診断: document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'))
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

  // ---- ログ（不良検知用） ----------------------------------------------------
  // 既定 'info'。通常タイピングでは 1 行も出さず、Enter に対する操作結果と警告だけ出す。
  // 'debug' に上げると、素通し・二重送信抑止・IME スキップまで記録する。
  //   変更（ページの console から）:
  //     localStorage.setItem('chatgptEnterKeyLogLevel', 'debug')   // 詳細
  //     localStorage.setItem('chatgptEnterKeyLogLevel', 'off')     // 無音
  //   自己診断（セレクタが生きているか等）:
  //     document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'))
  const VERSION = '0.4.0';
  const LOG_TAG = '[ChatGPT Enter Key]';
  const LOG_STORAGE_KEY = 'chatgptEnterKeyLogLevel';
  const SELF_TEST_EVENT = 'chatgptEnterKeySelfTest';

  function logLevel() {
    let level = 'info';
    if (typeof window.__chatgptEnterKeyLogLevel === 'string') {
      level = window.__chatgptEnterKeyLogLevel; // console からの上書き
    } else {
      try {
        const stored = window.localStorage && window.localStorage.getItem(LOG_STORAGE_KEY);
        if (stored) level = stored;
      } catch (_) {
        /* localStorage 使えなくても無視 */
      }
    }
    return level === 'off' || level === 'debug' ? level : 'info';
  }

  function logInfo(...args) {
    if (logLevel() !== 'off' && typeof console.info === 'function') console.info(LOG_TAG, ...args);
  }
  function logWarn(...args) {
    if (logLevel() !== 'off' && typeof console.warn === 'function') console.warn(LOG_TAG, ...args);
  }
  function logDebug(...args) {
    if (logLevel() === 'debug' && typeof console.debug === 'function') console.debug(LOG_TAG, ...args);
  }

  // 要素を 1 行で説明（生成 class 名も参考情報として出す＝判定には使わない）
  function describeTarget(el) {
    if (!el) return String(el);
    if (el === document) return '#document';
    if (typeof el.getAttribute !== 'function') return String(el.tagName || el);
    const parts = [String(el.tagName).toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    const cls = String(el.className || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    if (cls.length) parts.push('.' + cls.join('.'));
    for (const attr of ['role', 'aria-multiline', 'name', 'contenteditable', 'type', 'data-testid']) {
      const v = el.getAttribute(attr);
      if (v) parts.push('[' + attr + '=' + v + ']');
    }
    if (el.isContentEditable === true) parts.push('[editable]');
    return parts.join('');
  }

  // 動作回数と異常検知
  const stats = {
    enterNewline: 0, // Enter を改行に転換した回数
    send: 0, // 送信ボタンを click() した回数
    imeSkip: 0, // IME 変換中などで素通しした回数
    altSkip: 0,
    shiftPassthrough: 0,
    nonComposerEnter: 0, // 編集域だったが composer と特定できなかった回数
    noSendButton: 0,
    guarded: 0,
    keyUpStopped: 0, // strategy が keyup 停止を有効にした回数
  };
  const recentMisses = []; // 直近の「特定できなかった Enter」の時刻
  let warnedDetection = false;
  let warnedStuckComposition = false;

  // ---- Enter の扱い方針（strategy） ----------------------------------------
  // 重要: `stopPropagation()` は「同一ノード同一フェーズの他リスナー」を止められない。
  // window のキャプチャ段にあっても、ページ側（または注入の速い拡張）が window に
  // keydown を登録していると、その順は登録順で先に走るため Enter が送信に使える。
  // → 実効手段は (1) 注入を document_start にして登録順で先頭になる
  //   (2) stopImmediatePropagation() で同一ノード後続も断つ、の 2 点。
  // 段階（localStorage 'chatgptEnterKeyStrategy' で実行中に切り替えて検証できる）:
  //   stop                              ... v0.3 まではこの挙動（ページ側に負けることがある）
  //   stopImmediate                       ... 既定。同一ノード後続も断つ。改行は既定動作に委ねる
  //   stopImmediate+insertText            ... 既定動作も止めて自前で改行挿入（既定動作が死んでいる環境用）
  //   stopImmediate+insertText+killKeyUp  ... さらに Enter の keyup も断つ（keyup で送信する実装対策）
  const ENTER_STRATEGIES = [
    'stop',
    'stopImmediate',
    'stopImmediate+insertText',
    'stopImmediate+insertText+killKeyUp',
  ];
  const ENTER_STRATEGY_DEFAULT = 'stopImmediate';
  const STRATEGY_STORAGE_KEY = 'chatgptEnterKeyStrategy';
  const VERIFY_STORAGE_KEY = 'chatgptEnterKeyVerify';
  const VERIFY_NEWLINE_MS = 60; // 既定動作で改行が反映されたか見る待ち時間

  function readStored(key, windowKey) {
    if (typeof window[windowKey] === 'string') return window[windowKey];
    try {
      const stored = window.localStorage && window.localStorage.getItem(key);
      if (stored) return stored;
    } catch (_) {
      /* localStorage 使えなくても既定値 */
    }
    return null;
  }

  function enterStrategy() {
    const s = readStored(STRATEGY_STORAGE_KEY, '__chatgptEnterKeyStrategy');
    return s && ENTER_STRATEGIES.indexOf(s) !== -1 ? s : ENTER_STRATEGY_DEFAULT;
  }
  function usesStopImmediate(strategy) {
    return strategy !== 'stop';
  }
  function usesInsertText(strategy) {
    return strategy.indexOf('+insertText') !== -1;
  }
  function usesKillKeyUp(strategy) {
    return strategy.indexOf('+killKeyUp') !== -1;
  }

  // 改行が実際に DOM へ反映されたかを後から確認する（不良検知の要）
  function composerSignature(el) {
    try {
      return (el.innerHTML || '').length + ':' + el.childElementCount;
    } catch (_) {
      return null;
    }
  }
  function verifyNewlineEnabled() {
    return readStored(VERIFY_STORAGE_KEY, '__chatgptEnterKeyVerify') !== '0';
  }
  function verifyNewline(editable) {
    if (!verifyNewlineEnabled() || typeof window.setTimeout !== 'function') return;
    const before = composerSignature(editable);
    if (before === null) return;
    window.setTimeout(() => {
      const after = composerSignature(editable);
      if (after === null || after === before) {
        logWarn(
          'Enter: 送信ハンドラを止めたはずが composer の DOM が変わっていません。',
          '改行が挿入されていない（既定動作が止まっている）可能性があります。' +
            '→ localStorage.setItem("' +
            STRATEGY_STORAGE_KEY +
            '", "stopImmediate+insertText") で自前挿入に切り替えて確認してください。',
          { editable: describeTarget(editable), signature: after }
        );
      } else {
        logDebug('Enter: 既定の改行が DOM に反映されました', { before, after });
      }
    }, VERIFY_NEWLINE_MS);
  }

  // 自前挿入（既定動作を止める strategy でのみ使う）
  function insertNewlineSelf(editable) {
    try {
      if (typeof document.execCommand === 'function') {
        return document.execCommand('insertText', false, '\n') === true;
      }
    } catch (_) {
      /* execCommand 非対応でも既定動作に戻さない */
    }
    return false;
  }

  // ---- IME 状態 ------------------------------------------------------------

  let isComposingNow = false;
  let compositionStartedAt = -Infinity; // 滞留検知用（compositionstart の時刻）
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
      return Boolean(scope) && findSendButton(scope).button !== null;
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

  // 戻り値: { button, via } / via = 'selector' | 'name' | 'disabled' | 'none' | 'no-scope'
  function findSendButton(scope) {
    if (!scope) return { button: null, via: 'no-scope' };

    let sawDisabled = null;

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
      if (isEnabledButton(btn)) return { button: btn, via: 'selector', selector };
      // 候補要素自体は見つかっているが押下不可（生成中・空欄など）。他候補は続ける
      if (btn) sawDisabled = sawDisabled || selector;
    }

    // 名称一致に限定した最終フォールバック
    const buttons = Array.from(scope.querySelectorAll('button')).filter(isEnabledButton);
    const byName = buttons.find((btn) => SEND_NAME_RE.test(labelOf(btn))) || null;
    if (byName) return { button: byName, via: 'name' };
    return { button: null, via: sawDisabled ? 'disabled' : 'none', selector: sawDisabled };
  }

  let lastSendAt = -Infinity;
  let killNextEnterKeyUp = null; // { at } strategy で keyup も断つための照合用

  // 戻り値: 'sent'（click 済み）| 'guarded'（連打抑止で何もしない）
  function sendWith(button, event) {
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : Date.now();
    // 連打・キーリピートによる二重送信を防ぐ
    if (now - lastSendAt < SEND_GUARD_MS) return 'guarded';
    lastSendAt = now;

    // ChatGPT 側に Enter を渡さず、既定の改行挿入も止めてから click() する。
    // 同一ノード同一フェーズの後続リスナー（ページ側の window ハンドラ等）も
    // 断つ必要があるため stopImmediatePropagation() を使う。
    event.preventDefault();
    if (usesStopImmediate(enterStrategy())) event.stopImmediatePropagation();
    else event.stopPropagation();
    button.click();
    return 'sent';
  }

  // ---- 不良検知 -------------------------------------------------------------

  // 「編集域なのに composer と特定できなかった Enter」が短時間に続けば、
  // 改版でセレクタが死んだ疑いがあるので 1 回だけ警告する（成功すれば再武装）。
  // 検索欄・CodeMirror など明示的に除外した要素は数えない（正常な素通しのため）。
  function noteNonComposer(editable, event) {
    if (!editable) return; // 編集域自体が無い通常ページ内 Enter は数えない
    if (editable.matches(EXCLUDED_SELECTOR) || editable.closest(EXCLUDED_SELECTOR)) return;

    stats.nonComposerEnter += 1;

    const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
    recentMisses.push(now);
    while (recentMisses.length > 8) recentMisses.shift();
    if (warnedDetection || recentMisses.length < 4) return;

    const span = now - recentMisses[0];
    if (!(span >= 0 && span <= 10000)) return;
    warnedDetection = true;

    logWarn(
      '約 ' +
        Math.round(span / 1000) +
        ' 秒間に ' +
        recentMisses.length +
        ' 回 Enter を押しましたが、入力欄を composer として特定できませんでした。',
      '入力欄の構造が改版で変わった可能性があります（現行条件: ' +
        '#prompt-textarea かつ rich / contenteditable+role=textbox+aria-multiline=true / composer コンテナ配下の rich editable）。',
      {
        target: describeTarget(event.target),
        nearestEditable: describeTarget(editable),
      },
      '自己診断は: document.dispatchEvent(new CustomEvent("' + SELF_TEST_EVENT + '"))'
    );
  }

  // compositionstart ばかりで compositionend が届かない（IME フラグ滞留）と
  // Enter がずっと変換確定扱いになるため、長時間化したら警告する。
  function maybeWarnStuckComposition(event) {
    if (warnedStuckComposition || !isComposingNow || compositionStartedAt < 0) return;
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
    const elapsed = now - compositionStartedAt;
    if (!(elapsed > 5000)) return;
    warnedStuckComposition = true;
    logWarn(
      'IME の compositionstart から ' +
        Math.round(elapsed / 1000) +
        ' 秒経過しています。compositionend が届いていない可能性があり、Enter が変換確定扱いのまま素通され続けます。',
      '解消するには入力欄の外をクリックするか、ページを再読み込みしてください。'
    );
  }

  // ---- keydown ハンドラ ---------------------------------------------------

  function handleKeyDown(event) {
    if (event.key !== 'Enter') return;

    if (event.defaultPrevented === true) {
      logDebug('Enter: 他のハンドラが既に preventDefault 済み → 非干渉');
      return;
    }

    const editable = findEditableAncestor(event.target);
    const isComposer = Boolean(editable) && isComposerInput(editable);

    if (!isComposer) {
      noteNonComposer(editable, event); // 必要なら warn
      logDebug('Enter: 対象外（入力欄と特定できず）→ 非干渉', {
        target: describeTarget(event.target),
        editable: describeTarget(editable),
      });
      return;
    }

    // ここまで通った＝入力欄の検知は生きている。警告条件を解除する
    recentMisses.length = 0;
    warnedDetection = false;

    // IME 変換中（およびその直後）は絶対に触らない
    if (isImeActive(event)) {
      stats.imeSkip += 1;
      maybeWarnStuckComposition(event);
      logDebug('Enter: IME 変換中 → 非干渉', { isComposingNow, compositionStartedAt });
      return;
    }

    // Alt（AltGraph 含む）が混ざるものは原則として素通し
    if (event.altKey) {
      stats.altSkip += 1;
      logDebug('Enter: Alt 併用 → 素通し');
      return;
    }

    // Ctrl+Enter / Cmd+Enter: 送信ボタンを見つけて click()
    if (event.ctrlKey || event.metaKey) {
      const scope = composerScopeOf(editable);
      const found = findSendButton(scope);

      if (!found.button) {
        stats.noSendButton += 1;
        logWarn(
          'Ctrl+Enter: 送信ボタンが見つからず素通ししました。' +
            (found.via === 'disabled'
              ? '候補ボタンは存在しましたが押下不可でした（生成中・空欄など）。'
              : '送信ボタンのセレクタが改版で変わった可能性があります。'),
          {
            via: found.via,
            selector: found.selector || null,
            scope: describeTarget(scope),
          },
          '自己診断は: document.dispatchEvent(new CustomEvent("' + SELF_TEST_EVENT + '"))'
        );
        return;
      }

      if (found.via === 'name') {
        logWarn(
          'Ctrl+Enter: 候補セレクタに無いため名称一致（aria-label / title 等）で送信しました。セレクタ更新が必要です。',
          { button: describeTarget(found.button) }
        );
      }

      if (sendWith(found.button, event) === 'guarded') {
        stats.guarded += 1;
        logDebug('Ctrl+Enter: ' + SEND_GUARD_MS + 'ms 未満のため二重送信を抑止');
        return;
      }
      stats.send += 1;
      logInfo('Ctrl+Enter → 送信ボタン click()', {
        button: describeTarget(found.button),
        via: found.via,
      });
      return;
    }

    // Shift+Enter: ChatGPT 側の既定動作（改行）に任せる
    if (event.shiftKey) {
      stats.shiftPassthrough += 1;
      logDebug('Shift+Enter: 既定動作に委任');
      return;
    }

    // Enter 単独: 送信ハンドラに到達させない。既定の改行はそのまま働かせる。
    const strategy = enterStrategy();

    if (editable.tagName.toLowerCase() === 'input') {
      // 1 行 input の既定 Enter は form 送信になるため、それだけ止める（改行は不可）
      event.preventDefault();
    }
    // 「自前挿入」を選ぶなら既定動作も止める（既定動作が効いている環境では不要）
    const wantSelfInsert = usesInsertText(strategy) && editable.isContentEditable === true;
    if (wantSelfInsert) event.preventDefault();

    // ここが要点: stopPropagation() では「同一ノード同一フェーズの後続リスナー」が
    //止められない。window に keydown を登録している実装があると Enter が送信に
    //使えるため、既定 strategy では stopImmediatePropagation() で断つ。
    if (usesStopImmediate(strategy)) event.stopImmediatePropagation();
    else event.stopPropagation();

    let selfInserted = false;
    if (wantSelfInsert) selfInserted = insertNewlineSelf(editable);
    if (usesKillKeyUp(strategy)) killNextEnterKeyUp = { at: event.timeStamp };

    stats.enterNewline += 1;
    logInfo('Enter → 改行（strategy: ' + strategy + '）', {
      editable: describeTarget(editable),
      selfInserted: wantSelfInsert ? selfInserted : null,
    });

    if (wantSelfInsert) {
      if (!selfInserted) {
        logWarn(
          'Enter: 自前挿入（execCommand insertText）に失敗しました。改行が増えない可能性があります。',
          { editable: describeTarget(editable) }
        );
      }
    } else {
      verifyNewline(editable); // 既定動作で改行が DOM に反映されたか後で確認
    }
  }

  // ---- 登録 ---------------------------------------------------------------

  // compositionstart / compositionend は capture で受ける（どちらで届いても対応）
  window.addEventListener(
    'compositionstart',
    (event) => {
      isComposingNow = true;
      compositionStartedAt = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
    },
    true
  );

  window.addEventListener(
    'compositionend',
    (event) => {
      isComposingNow = false;
      compositionStartedAt = -Infinity;
      warnedStuckComposition = false; // 次の変換で again 検知する
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
  // （manifest の run_at を document_start にしているので登録順で先頭になれる）
  window.addEventListener('keydown', handleKeyDown, true);

  // strategy が keyup 停止を選ぶ場合のみ、Enter の keyup を対で断つ。
  // keydown を完全に止めても keyup は別途届くため、keyup で送信する実装対策。
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key !== 'Enter' || !killNextEnterKeyUp) return;
      const matched = killNextEnterKeyUp.at === event.timeStamp;
      killNextEnterKeyUp = null;
      if (!matched) return;
      stats.keyUpStopped += 1;
      event.stopImmediatePropagation();
      logDebug('Enter keyup: keydown と対のため停止');
    },
    true
  );

  // ---- 自己診断 -------------------------------------------------------------
  // 入力欄・送信ボタンのセレクタが現行 DOM で生きているかをその場で確認する。
  // ページの console から（拡張の console context を選ばなくても動く）:
  //   document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'))
  const COMPOSER_PROBE_SELECTORS = [
    '#prompt-textarea[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"][aria-multiline="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea[name="prompt-textarea"]', // 非表示 fallback: accepted=false が正しい挙動
  ];

  function selfTest() {
    const probes = [];
    let accepted = null;

    for (const selector of COMPOSER_PROBE_SELECTORS) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        nodes = [];
      }
      const first = nodes[0] || null;
      const ok = first ? isComposerInput(first) : false;
      if (ok && !accepted) accepted = first;
      probes.push({
        selector,
        count: nodes.length,
        element: describeTarget(first),
        accepted: ok,
      });
    }

    const scope = accepted
      ? composerScopeOf(accepted)
      : document.querySelector(COMPOSER_CONTAINER_SELECTOR) || document;
    const found = findSendButton(scope);

    const report = {
      version: VERSION,
      url: location.href,
      config: {
        runAt: 'document_start',
        logLevel: logLevel(),
        strategy: enterStrategy(),
        verifyNewline: verifyNewlineEnabled(),
      },
      composer: probes,
      sendButton: {
        via: found.via,
        selector: found.selector || null,
        button: describeTarget(found.button),
        scope: describeTarget(scope),
      },
      ime: { isComposingNow, compositionStartedAt, compositionEndedAt },
      stats: Object.assign({}, stats),
    };

    logInfo('自己診断:', report);

    if (!accepted) {
      logWarn(
        '自己診断: 入力欄を 1 つも特定できませんでした。',
        'チャックスレッドが開かれた状態で実行してください。それでも出ない場合はセレクタ更新が必要です（content.js の isComposerInput）。'
      );
    }
    if (!found.button) {
      logWarn(
        '自己診断: 送信ボタンを特定できませんでした（via=' +
          found.via +
          '）。Ctrl+Enter が効かない状態です。',
        'content.js の SEND_BUTTON_SELECTORS に実 DOM のセレクタを追加してください。'
      );
    }
    return report;
  }

  // ページ側から呼べる入口（isolated world の関数は DevTools の
  // 「JavaScript console context」で本拡張を選ぶと直接呼べる）
  window.__chatgptEnterKeySelfTest = selfTest;
  window.__chatgptEnterKeyStats = () => Object.assign({}, stats);
  window.__chatgptEnterKeyVersion = VERSION;
  document.addEventListener(SELF_TEST_EVENT, () => {
    selfTest();
  });

  // 注入自体が効いていることの証（ページ読み込み時に 1 行だけ）
  logInfo(
    'v' +
      VERSION +
      ' 読み込み完了 (run_at=document_start): Enter=改行 / Ctrl+Enter・Cmd+Enter=送信 / ' +
      'Shift+Enter=既定動作 / Alt+Enter=非干渉。Enter 方針=' +
      enterStrategy() +
      '（切り替え: localStorage.setItem("' +
      STRATEGY_STORAGE_KEY +
      '", "<方針>")、' +
      'ログ詳細: localStorage.setItem("chatgptEnterKeyLogLevel", "debug")、' +
      '自己診断: document.dispatchEvent(new CustomEvent("' +
      SELF_TEST_EVENT +
      '"))'
  );
})();
