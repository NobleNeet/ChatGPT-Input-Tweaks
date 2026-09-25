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
 *   - ChatGPT 本体と同じ MAIN world で、keydown を window のキャプチャ段
 *     （document より上流＝最も早い段）で受け取り、
 *     event.target から都度「ChatGPT の入力欄か？」を判定する委譲方式。
 *     SPA で DOM が再生成されるため、要素参照は一切保持しない。
 *   - 「Enter で改行」は元のイベントを ChatGPT 側から Shift+Enter に見えるようにし、
 *     ChatGPT / ProseMirror 自身の改行処理へ委任する。
 *     → DOM 書き換えや KeyboardEvent の生成・再発行は行わない。
 *   - 「Ctrl+Enter で送信」は KeyboardEvent を作り直して再発行しない。
 *     送信ボタン要素を見つけて click() する。
 *   - 送信ボタンが見つからない場合はイベントを素通しする（暴走防止）。
 *   - 入力欄は textarea ではなく ProseMirror の contenteditable div。
 *     生成された class 名（wcDTda_* 等）と aria-label には依存しない。
 *     role="textbox" / aria-multiline="true" も**必須条件ではない**（補助シグナル扱い）。
 *   - 不良検知用のログを出す（既定 info / localStorage 'chatgptEnterKeyLogLevel' で切替）。
 *     通常タイピングでは無出力。入力内容そのものは出力しない。
 *     自己診断: document.dispatchEvent(new CustomEvent('chatgptEnterKeySelfTest'))
 *     要素単位の判定確認: window.__chatgptEnterKeyProbe('#prompt-textarea')
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
    '[data-chatgpt-composer]',
    '#composer',
    '[data-testid="composer"]',
    '[data-test-id="composer"]',
    '.composer-sender',
  ].join(', ');

  // 実入力欄と同じコンテナに置かれる非表示 fallback（これ自体は対象にしない）
  const PROMPT_FALLBACK_SELECTORS = [
    'textarea[name="prompt-textarea"]',
    'input[name="prompt-textarea"]',
  ];

  // 改版でラッパーが増えた場合の保険として、fallback を実入力欄の「近傍」から探す。
  // 近傍 = 実入力欄から最大 2 階層上までの容器の中（その容器から見て孫までの深さ）。
  // 上・下とも浅く上限を置くのは、body / html まで遡ると本文側の別編集域が
  // ページ全体の fallback を拾ってしまうため（＝誤検知）。旧 DOM は同親＝上0・下1。
  const PROMPT_FALLBACK_ANCESTOR_DEPTH = 2;
  const PROMPT_FALLBACK_NEARBY_QUERY = PROMPT_FALLBACK_SELECTORS.flatMap((base) => [
    ':scope > ' + base,
    ':scope > * > ' + base,
  ]).join(', ');

  // 誤検知してはいけない入力 UI（検索欄・コードエディタ・非表示 fallback など）
  const EXCLUDED_SELECTOR = [
    // 非表示の fallback textarea（実入力欄と同じ親要素に置かれる）
    ...PROMPT_FALLBACK_SELECTORS,
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
  const VERSION = '0.9.1';
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
    keyUpStopped: 0, // remap失敗時にkeyupを停止した回数
    sendFollowupStopped: 0, // Ctrl/Cmd+Enter 送信後の keypress / keyup を停止した回数
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
  //   remapToShiftEnter ... 既定。元のEnterをShift+EnterとしてChatGPTへ委任
  //   stop              ... v0.3 までの挙動（ページ側に負けることがある）
  //   stopImmediate     ... 送信を断つが、環境によっては改行も行われない
  const ENTER_STRATEGIES = [
    'remapToShiftEnter',
    'stop',
    'stopImmediate',
  ];
  const ENTER_STRATEGY_DEFAULT = 'remapToShiftEnter';
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

  // 新しいイベントは作らず、同じイベントをページ側からShift+Enterに見せる。
  function remapAsShiftEnter(event) {
    try {
      Object.defineProperty(event, 'shiftKey', {
        configurable: true,
        value: true,
      });
    } catch (_) {
      return false;
    }

    const originalGetModifierState = event.getModifierState;
    if (typeof originalGetModifierState === 'function') {
      try {
        Object.defineProperty(event, 'getModifierState', {
          configurable: true,
          value(modifier) {
            if (modifier === 'Shift') return true;
            return originalGetModifierState.call(this, modifier);
          },
        });
      } catch (_) {
        // shiftKey 自体を変更できていればReact等の通常判定には十分。
      }
    }
    return event.shiftKey === true;
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
          'Enter 操作後も composer の DOM が変わっていません。',
          'ChatGPT 側の Shift+Enter 改行処理が実行されなかった可能性があります。',
          { editable: describeTarget(editable), signature: after }
        );
      } else {
        logDebug('Enter: 既定の改行が DOM に反映されました', { before, after });
      }
    }, VERIFY_NEWLINE_MS);
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
  // 現行 DOM（docs/chatgpt-dom-sample.txt 参照）では入力欄は
  //   <form data-chatgpt-composer><div contenteditable="true" ...></div></form>
  // 内にある。旧 DOM の id="prompt-textarea" や非表示 fallback textarea も
  // 後方互換の根拠として扱う（fallback 自体は対象にしない）。
  //
  // 判定はすべて event.target から都度行う（SPA で DOM が再生成されるため
  // 要素参照を保持しない）。生成された class 名（wcDTda_* 等）と aria-label は
  // 判定に使わない。
  //
  // ARIA 属性（role="textbox" / aria-multiline="true"）は必須条件ではない。
  // 改版でこれらの属性が消えても実入力欄を捕らえ続けられるよう、contenteditable を
  // 受理する条件は「ChatGPT composer 固有の強い根拠」（hasStrongComposerIdentity）に置く。
  // ARIA 属性は補助シグナルとして診断ログ・自己診断に記録するだけで、
  // ARIA 属性だけを根拠に受理する経路は意図的に無い（一般の contenteditable 対策）。

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

  // 富テキスト編集域か。ARIA 属性には依存しない（改版で role が消えても成立する）。
  function isContentEditableLike(el) {
    return el.isContentEditable === true;
  }

  // ARIA 上はリッチな複数行テキストボックスに見える、という補助シグナル。
  // 単独では受理しない（ChatGPT composer と一般の編集領域を区別できないため）。
  function hasRichTextboxSemantics(el) {
    return el.getAttribute('role') === 'textbox' && el.getAttribute('aria-multiline') === 'true';
  }

  // 同一（または近傍）コンテナに非表示 fallback があるか。
  // 旧 DOM では実入力欄と同親。改版でラッパーが増えた場合に備え浅い階層まで遡るが、
  // body / html まで遡らないこと、fallback 自身や fallback を内包する要素が
  // 自己参照して通らないことを条件にしている。
  function hasPromptFallbackNearby(el) {
    let container = el.parentElement;
    for (let depth = 0; container && depth < PROMPT_FALLBACK_ANCESTOR_DEPTH; depth += 1) {
      // ページ全体まで遡ると本文側の別編集域が composer の fallback を拾う
      if (container === document.body || container === document.documentElement) break;
      let fallback = null;
      try {
        fallback = container.querySelector(PROMPT_FALLBACK_NEARBY_QUERY);
      } catch (_) {
        fallback = null; // 将来の selector が構文エラーでも続行
      }
      if (fallback && fallback !== el && !el.contains(fallback)) return true;
      container = container.parentElement;
    }
    return false;
  }

  // ChatGPT の composer であることを示す強い根拠（ARIA 属性はここで使わない）。
  function hasStrongComposerIdentity(el) {
    // 旧 DOM の ID。role / aria-multiline が消えても効く。
    if (el.id === 'prompt-textarea') return true;
    // 現行の data-chatgpt-composer または旧 semantic composer container の内部。
    if (isInsideComposer(el)) return true;
    // 同一または近傍コンテナに prompt fallback がある（旧 DOM の構成）。
    if (hasPromptFallbackNearby(el)) return true;
    return false;
  }

  // contenteditable を ChatGPT の composer として扱ってよいか。
  // 「編集可能」＋「強い根拠」だけで判定し、role / aria-multiline が無くても受理する。
  // 逆に強い根拠が無い一般の contenteditable は、ARIA 属性が揃っていても拒否する。
  function isLikelyChatGptComposer(el) {
    return isContentEditableLike(el) && hasStrongComposerIdentity(el);
  }

  // 診断用: なぜ受理（または拒否）したかを属性レベルで切り分ける。
  // 判定そのものには使わず、警告ログ・自己診断・window.__chatgptEnterKeyProbe に出す。
  function composerEvidence(el) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    return {
      element: describeTarget(el),
      editable: isContentEditableLike(el),
      ariaRich: hasRichTextboxSemantics(el), // 補助シグナル（必須ではない）
      promptId: el.id === 'prompt-textarea',
      inComposerContainer: isInsideComposer(el),
      promptFallbackNearby: hasPromptFallbackNearby(el),
      excluded: el.matches(EXCLUDED_SELECTOR) || Boolean(el.closest(EXCLUDED_SELECTOR)),
      rendered: isRendered(el),
      disabled: el.disabled === true,
    };
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
    const isRich = isContentEditableLike(el);
    if (!isTextControl && !isRich) return false;

    // 明示的に除外（自分自身および祖先を含む）
    if (el.matches(EXCLUDED_SELECTOR) || el.closest(EXCLUDED_SELECTOR)) return false;

    // 富テキスト編集域: composer 固有の強い根拠があれば ARIA 属性の有無を問わない。
    // （isLikelyChatGptComposer は contenteditable 実体しか通さないため、
    //   id / name が同名の fallback textarea はこの経路に寄せ付けない）
    if (isRich) return isLikelyChatGptComposer(el);

    // 旧 textarea 構成向け。可視かつ「送信らしきボタンのある form」に限る
    const scope = el.closest('form') || (isInsideComposer(el) ? el.parentElement : null);
    return Boolean(scope) && findSendButton(scope).button !== null;
  }

  // Ctrl+Enter の送信対象を辿るスコープ。
  // rich editor（contenteditable）は form でラップされていないことが多く、
  // form まで落とすと本文全体が scope 化して誤ヒットするため、
  // 「composer コンテナ → form → 送信ボタンを含む近い祖先」の順で探す。
  function composerScopeOf(el) {
    if (el.isContentEditable === true) {
      const semanticScope = el.closest(COMPOSER_CONTAINER_SELECTOR) || el.closest('form');
      if (semanticScope) return semanticScope;

      // 旧DOMのようにform等が無い場合、送信ボタンを含む最も近い祖先まで限定的に辿る。
      let scope = el.parentElement;
      for (let depth = 0; scope && depth < 6; depth += 1) {
        const found = findSendButton(scope);
        if (found.via !== 'none' && found.via !== 'no-scope') return scope;
        if (scope === document.body || scope === document.documentElement) break;
        scope = scope.parentElement;
      }
      return el.parentElement || null;
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
  let remappedPlainEnter = null; // { at } keypress / keyupにもShift状態を引き継ぐ
  let suppressedPlainEnter = null; // remap失敗時にkeypress / keyupを安全側で断つ
  let suppressedSendEnter = null; // Ctrl/Cmd+Enter 送信後の keypress / keyup を安全側で断つ

  // 戻り値: 'sent'（click 済み）| 'guarded'（連打抑止で何もしない）
  function sendWith(button, event) {
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : Date.now();
    // ChatGPT 側に Enter を渡さず、既定の改行挿入も止めてから click() する。
    // 同一ノード同一フェーズの後続リスナー（ページ側の window ハンドラ等）も
    // 断つ必要があるため stopImmediatePropagation() を使う。
    event.preventDefault();
    if (usesStopImmediate(enterStrategy())) event.stopImmediatePropagation();
    else event.stopPropagation();

    // 連打・キーリピート時もイベントは止め、ChatGPT 側の処理による二重送信を防ぐ。
    // ChatGPT 側が keyup 等で Ctrl/Cmd+Enter の別ショートカットを解釈する場合に備え、
    // この送信操作に対応する後続 Enter イベントも短時間だけ追跡して遮断する。
    suppressedSendEnter = { at: now };
    if (now - lastSendAt < SEND_GUARD_MS) return 'guarded';
    lastSendAt = now;

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
      '入力欄の構造が改版で変わった可能性があります（現行条件: contenteditable かつ ' +
        '#prompt-textarea / composer コンテナ配下 / 近傍に fallback textarea のいずれか。' +
        'role="textbox" と aria-multiline="true" は必須ではない）。',
      {
        target: describeTarget(event.target),
        nearestEditable: describeTarget(editable),
        evidence: composerEvidence(editable),
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
        evidence: composerEvidence(editable),
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

    // Enter 単独: 既定方針では同じイベントをShift+EnterとしてChatGPTへ委任する。
    const strategy = enterStrategy();

    if (strategy === 'remapToShiftEnter') {
      if (remapAsShiftEnter(event)) {
        remappedPlainEnter = { at: event.timeStamp };
        stats.enterNewline += 1;
        verifyNewline(editable);
        logInfo('Enter → Shift+Enter として ChatGPT に委任', {
          editable: describeTarget(editable),
          remappedShiftKey: event.shiftKey,
        });
        return;
      }

      // remapできない環境では送信防止を優先し、このEnterを完全に止める。
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedPlainEnter = { at: event.timeStamp };
      logWarn('Enter を Shift+Enter として扱えなかったため、誤送信防止のため停止しました。');
      return;
    }

    if (editable.tagName.toLowerCase() === 'input') {
      // 1 行 input の既定 Enter は form 送信になるため、それだけ止める（改行は不可）
      event.preventDefault();
    }
    // ここが要点: stopPropagation() では「同一ノード同一フェーズの後続リスナー」が
    //止められない。window に keydown を登録している実装があると Enter が送信に
    //使えるため、既定 strategy では stopImmediatePropagation() で断つ。
    if (usesStopImmediate(strategy)) event.stopImmediatePropagation();
    else event.stopPropagation();

    stats.enterNewline += 1;
    logInfo('Enter → 改行（strategy: ' + strategy + '）', {
      editable: describeTarget(editable),
    });
    verifyNewline(editable);
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

  // keydown 後の keypress にも、remapしたShift状態を引き継ぐ。
  window.addEventListener(
    'keypress',
    (event) => {
      if (event.key !== 'Enter') return;
      const editable = findEditableAncestor(event.target);

      if (suppressedSendEnter) {
        const elapsed = event.timeStamp - suppressedSendEnter.at;
        if (elapsed >= 0 && elapsed < 2000 && isComposerInput(editable)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          stats.sendFollowupStopped += 1;
          logDebug('Ctrl/Cmd+Enter keypress: keydown と対のため停止');
          return;
        }
        if (!(elapsed >= 0 && elapsed < 2000)) suppressedSendEnter = null;
      }

      if (remappedPlainEnter) {
        const elapsed = event.timeStamp - remappedPlainEnter.at;
        if (elapsed >= 0 && elapsed < 30000 && isComposerInput(editable)) {
          remapAsShiftEnter(event);
          logDebug('Enter keypress: Shift+Enter 状態を引き継ぎ');
        }
        return;
      }

      if (!suppressedPlainEnter) return;
      const elapsed = event.timeStamp - suppressedPlainEnter.at;
      if (!(elapsed >= 0 && elapsed < 2000 && isComposerInput(editable))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      logDebug('Enter keypress: keydown と対のため停止');
    },
    true
  );

  // keyup は別イベントとして届くため、同じEnter操作のものだけ断つ。
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key !== 'Enter') return;
      const editable = findEditableAncestor(event.target);

      if (suppressedSendEnter) {
        const elapsed = event.timeStamp - suppressedSendEnter.at;
        const matched = elapsed >= 0 && elapsed < 2000 && isComposerInput(editable);
        suppressedSendEnter = null;
        if (matched) {
          event.preventDefault();
          event.stopImmediatePropagation();
          stats.sendFollowupStopped += 1;
          logDebug('Ctrl/Cmd+Enter keyup: keydown と対のため停止');
          return;
        }
      }

      if (remappedPlainEnter) {
        const elapsed = event.timeStamp - remappedPlainEnter.at;
        const matched = elapsed >= 0 && elapsed < 30000 && isComposerInput(editable);
        remappedPlainEnter = null;
        if (matched) {
          remapAsShiftEnter(event);
          logDebug('Enter keyup: Shift+Enter 状態を引き継ぎ');
        }
        return;
      }

      if (!suppressedPlainEnter) return;
      const elapsed = event.timeStamp - suppressedPlainEnter.at;
      const matched = elapsed >= 0 && elapsed < 2000 && isComposerInput(editable);
      suppressedPlainEnter = null;
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
  const COMPOSER_PROBE_SELECTOR = COMPOSER_PROBE_SELECTORS.join(', ');

  // 実際に検出した DOM 要素を自動で console に出す。
  // WeakSet なので、SPA で破棄された入力欄を診断機能が保持し続けることはない。
  const loggedComposerElements = new WeakSet();
  let hasDetectedComposer = false;
  let diagnosticScanQueued = false;
  const diagnosticRoots = new Set();

  function composerCandidatesWithin(root) {
    const candidates = [];
    if (root instanceof Element && root.matches(COMPOSER_PROBE_SELECTOR)) {
      candidates.push(root);
    }
    if (root && typeof root.querySelectorAll === 'function') {
      candidates.push(...root.querySelectorAll(COMPOSER_PROBE_SELECTOR));
    }
    return Array.from(new Set(candidates));
  }

  function logComposerElementsWithin(root) {
    for (const element of composerCandidatesWithin(root)) {
      if (!isComposerInput(element) || loggedComposerElements.has(element)) continue;
      loggedComposerElements.add(element);
      hasDetectedComposer = true;
      // 要素そのものを渡すため、DevTools から展開・inspect できる。
      logInfo('ChatGPT の入力欄 DOM を検出しました:', element);
    }
  }

  function queueComposerDiagnosticScan(root) {
    diagnosticRoots.add(root || document);
    if (diagnosticScanQueued) return;
    diagnosticScanQueued = true;
    window.requestAnimationFrame(() => {
      diagnosticScanQueued = false;
      for (const scanRoot of diagnosticRoots) logComposerElementsWithin(scanRoot);
      diagnosticRoots.clear();
    });
  }

  function startComposerDiagnostics() {
    queueComposerDiagnosticScan(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          const semanticAttribute =
            mutation.attributeName !== 'style' && mutation.attributeName !== 'hidden';
          if (semanticAttribute || target.matches(COMPOSER_PROBE_SELECTOR)) {
            queueComposerDiagnosticScan(target);
          }
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.matches(COMPOSER_PROBE_SELECTOR) ||
            node.querySelector(COMPOSER_PROBE_SELECTOR)
          ) {
            queueComposerDiagnosticScan(node);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['id', 'contenteditable', 'role', 'aria-multiline', 'hidden', 'style'],
    });

    window.setTimeout(() => {
      logComposerElementsWithin(document);
      if (!hasDetectedComposer) {
        logWarn(
          'ページ読み込み後 15 秒以内に ChatGPT の入力欄 DOM を検出できませんでした。',
          'チャット画面を開いている場合は入力欄の DOM 構造が変わった可能性があります。',
          '再確認: document.dispatchEvent(new CustomEvent("' + SELF_TEST_EVENT + '"))'
        );
      }
    }, 15000);
  }

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
      const firstAccepted = nodes.find((node) => isComposerInput(node)) || null;
      if (firstAccepted && !accepted) accepted = firstAccepted;
      probes.push({
        selector,
        count: nodes.length,
        element: describeTarget(firstAccepted || first),
        accepted: Boolean(firstAccepted),
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
        world: 'MAIN',
        runAt: 'document_start',
        logLevel: logLevel(),
        strategy: enterStrategy(),
        verifyNewline: verifyNewlineEnabled(),
      },
      // DevTools から直接 inspect できるよう、文字列化せず実要素も含める。
      composerElement: accepted,
      // 受理（または拒否）の理由を属性レベルに切り分けたもの
      composerEvidence: composerEvidence(accepted),
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

  // MAIN world なのでページの DevTools console から直接呼べる診断用入口。
  window.__chatgptEnterKeySelfTest = selfTest;
  window.__chatgptEnterKeyStats = () => Object.assign({}, stats);
  // 任意要素が「今この瞬間の DOM」で composer として受理されるかの確認（診断用）。
  //   window.__chatgptEnterKeyProbe(document.getElementById('prompt-textarea'))
  //   window.__chatgptEnterKeyProbe('#prompt-textarea')
  window.__chatgptEnterKeyProbe = (target) => {
    let el = target;
    if (typeof target === 'string') {
      try {
        el = document.querySelector(target);
      } catch (_) {
        el = null;
      }
    }
    // keydown ハンドラと同じ解決経路（編集域そのものでない target は外側へ探す）
    const editable = (el && !isContentEditableLike(el) ? findEditableAncestor(el) : null) || el;
    return {
      version: VERSION,
      element: describeTarget(el),
      resolved: describeTarget(editable),
      accepted: isComposerInput(editable),
      // accepted の内訳。ariaRich は補助シグナルで、true でも単独では受理しない
      evidence: composerEvidence(editable),
    };
  };
  window.__chatgptEnterKeyVersion = VERSION;
  document.addEventListener(SELF_TEST_EVENT, () => {
    selfTest();
  });

  if (document.documentElement) {
    startComposerDiagnostics();
  } else {
    document.addEventListener('DOMContentLoaded', startComposerDiagnostics, { once: true });
  }

  // 注入自体が効いていることの証（ページ読み込み時に 1 行だけ）
  logInfo(
    'v' +
      VERSION +
      ' 読み込み完了 (world=MAIN, run_at=document_start): Enter=改行 / Ctrl+Enter・Cmd+Enter=送信 / ' +
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
