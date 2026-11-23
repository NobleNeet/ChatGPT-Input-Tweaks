/**
 * ChatGPT 会話ナビゲーションバー（コンテンツスクリプト追加分）
 *
 * 画面右端に各 assistant 回答対応の短い横線を縦に並べる。
 * クリックで回答冒頭へジャンプし、現在位置の回答を青色で示す。
 *
 * 設計メモ
 *   - ChatGPT は仮想スクロールで会話全体を DOM に持たないため、
 *   「一度 DOM で検出した回答」をメモリ内キャッシュに蓄積してマーカーを維持する。
 *   - キャッシュの識別子は turnKey (+ messageId) 。DOM 要素参照は
 *     永続的な識別には使わず、必要時に transcript 内へ再 query する。
 *   - 未描画（一度も DOM に出ていない）回答の件数・ID は推測しない。
 *     マーカーは実測できた回答のみが順に増える。
 *   - 非公開 API・ネットワーク通信・フレームワーク内部状態へのアクセスはしない。
 *     DOM の観察（data-* 属性）だけを使う。
 *   - 重い処理は最低間隔で合流（coalesce）し、スクロール追従は rAF で間引く。
 *     ナビ UI 自身の mutation はスキップし、応答生成中の高頻度更新でも
 *     1 回あたりの走査は transcript 内の描画中ノード数に比例する有界処理。
 *   - 回答生成中（本文が毎フレーム伸びる）は「構造（キー順・在DOM状態）が
 *     動かないなら DOM を再構築しない」ことで mutation ループを断つ。
 *   - 日志: localStorage 'chatgptNavLogLevel'
 *       'debug' ... 全ログ / 'warn' または 'info' ... 警告のみ / 'off' ... 無音
 *       （未設定なら 'warn'。ジャンプ失敗などは既定でコンソールに見える）
 *   - 診断: window.__chatgptNav.snapshot()
 */
(() => {
  'use strict';

  if (window.__chatgptNavLoaded) return;
  window.__chatgptNavLoaded = true;

  // ---- 定数 --------------------------------------------------------------

  const NAV_VERSION = '0.10.15';
  const LOG_TAG = '[ChatGPT Nav]';
  const LOG_STORAGE_KEY = 'chatgptNavLogLevel';

  // 会話コンテナ / assistant 回答見出し / 回答本文
  const TRANSCRIPT_SELECTOR = '[data-rail-chat-transcript="true"]';
  const HEADING_SELECTOR = 'h4[data-conversation-role="assistant"]';
  const UNIT_KEY_SELECTOR = '[data-content-search-unit-key]';
  const RESPONSE_BODY_SELECTOR = '[data-response-body]';
  const TURN_KEY_SELECTOR = '[data-turn-key]';
  const CONV_TARGET_SELECTOR = '[data-chatgpt-conversation-selection-target]';

  const PREVIEW_CHARS = 180;      // ツールチップ用：回答冒頭を取り出す文字数
  const TOP_OFFSET_MIN = 24;      // ジャンプ着地・基準線オフセット [px]
  const TOP_OFFSET_MAX = 120;
  const ROW_BASE_H = 14;          // 1 マーカー高（通常） [px]
  const ROW_MIN_H = 5;            // 1 マーカー高（最小。これを下回るならバー内スクロール）
  const BAR_VH = 0.72;           // バーの最大高さ = 視覚高度 × これ
  const SCAN_COALESCE_MS = 180;  // MutationObserver → scan の合流間隔
  const JUMP_APPROX_MS = 2500;   // キャッシュ位置ジャンプ後の再描画待ち上限
  const JUMP_SMOOTH_MS = 1500;   // smooth スクロール完了待ち上限
  const CACHE_MAX = 800;         // 応答キャッシュ上限（超過は最久未観測の非在DOM分のみEvict）
  const SAFETY_INTERVAL_MS = 2000; // observer 死角の保険巡回（画面非表示時は停止）
  // ジャンプ直後に「まだ何も発射していないのに最下部へ吸着」している疑いを
  // 見てから再ジャンプする猶予窓 [ms]。狭すぎると smooth 発射直後の誤検知、
  // 広すぎると本当に拉致された時の修正が遅れる
  const JUMP_REASSERT_WINDOW_MS = 1200;
  const JUMP_REASSERT_MIN_WAIT_MS = 60; // smooth/scroll 発射直後の一瞬は除外
  const JUMP_SNAP_TOL = 4;            // 「最下部に居る」判定の誤差 [px]

  // v0.10.14: Alt+↑ で「表示中の回答の冒頭がまだ画面外（アンカーラインより上）」
  // のとき、1つ前ではなくその回答自身の冒頭を目標にする。この「冒頭が
  // 見えている」判定の許容誤差 [px]（着地位置がアンカーライン ± これ
  // 以内なら冒頭に見えている扱い）
  const JUMP_CURRENT_TOP_TOL = 12;

  // v0.10.13: 下端 pull 検知後、アンカー推定も max と一致して打つ手が
  // 無いとき、少し待ってから jumpTo をまるごと再発射する（手動で
  // 「もう一回クリック」と同じ。ChatGPT の再測高を待って撃ち直す）。
  // 無限ループ防止に上限を設ける。
  const JUMP_BOTTOM_PULL_REFIRE_MAX = 2;   // 再発射上限回数
  const JUMP_BOTTOM_PULL_REFIRE_MS = [600, 1200]; // 予約待ち時間 [ms]

  // 合成ホイール＝「利用者のスクロール意図」信号。我々のプログラム的スクロールを
  // ChatGPT の「自動追従（最下部固定）」が直後に最下部へ引き戻す症状
  // （冒頭→最下部的反動）に対する対策。ジャンプ中これを間欠的に発射する。
  const JUMP_INTENT_MS = 120;         // 意図イベントの再発射間隔 [ms]
  const JUMP_INTENT_COVER_MS = 700;   // 発射から意図を出し続ける窓 [ms]

  // 「ジャンプが丸飲みされた」判定：目標は遠いのにスクロールが start から
  // 全く動かない状態がこれだけ続いたら再発射する（実測：2回目のクリックは効く
  // ＝1回目のスクロールだけ Pin されている。それを自力でやる）
  const JUMP_STUCK_MIN_MS = 250;  // 動き出しを待つ最短時間 [ms]
  const JUMP_STUCK_TOL = 4;       // これ未満しか動いていなければ「未実行」扱い [px]

  // smooth の途中でスクロールが「フリーズ」する件：実機ログで
  // 「仮想化 reflow でスクロールコンテナの高さが変わる（sh 16072→13004）
  // → 上部の座標系ごとずれ、保存済み target が無意味化し smooth が
  // 途中で死ぬ」ことを確認。動きが無い状態が続いたら LIVE の DOM 実測で
  // 1回だけ位置補正する（保存済み target は絶対信用しない）。
  const JUMP_STALL_MS = 220;      // 「停滞」判定の無時間経過 [ms]
  const JUMP_STALL_TOL = 2;       // この未満の動きは「動いていない」[px]

  // stall 補正（LIVE 実測 auto / rel re-aim）の合計予算。実機ログでは
  // reflow は 1 回で終わらない（load-more のアンカーシフトで再度ズレ、
  // 対象が再び DOM から消える）ため、単発修正では追いつけない。
  // 「実測→発射→再実測」ループで収束させるが、合計回数だけ上限を
  // 設けて無限リトライ禁止（spec の有限リトライ要件）も守る。
  const JUMP_MAX_FIXES = 3;
  // rel ベース re-aim を発射するに必要な最低移動量 [px]。
  // もう近い位置なら無駄なスクロールをしない（keep waiting）。
  const JUMP_REAIM_MIN_DX = 60;

  // v0.10.9: 実機ログで確定した通り、仮想化の崩壊フレームでは cached な
  // absolute も relative も狂う（上方 culling で座標系ごとズレ rel も変わる）。
  //  surviving するのは ①ターン自高（data-virtualized-turn の offsetHeight）
  // ②items[] の会話順 ③「今レンダリング済みブロックは画面に居る」こと。
  // この3点から目標位置を再推定して撃ち直す（hill-climb re-aim）。
  const JUMP_GUESS_MS = 500;    // re-aim 最短間隔（クールダウン）[ms]
  const JUMP_MAX_GUESS = 5;     // anchor re-aim 予算（fixes とは別枠）
  const TURN_GAP_PX = 12;       // ターン間の間隔（実測）[px]

  const JUMP_CANCEL_KEYS = new Set([
    'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown',
  ]);

  // ---- ログ --------------------------------------------------------------

  function logLevel() {
    let level = 0; // 既定 'warn'
    try {
      const stored = (localStorage.getItem(LOG_STORAGE_KEY) || 'warn').toLowerCase();
      if (stored === 'debug') level = 2;
      else if (stored === 'info') level = 1;
      else if (stored === 'warn') level = 0;
      else level = -1; // 'off' 等は完全無音
    } catch (_) {
      level = 0;
    }
    return level;
  }
  const logWarn = (msg, ...rest) => {
    if (logLevel() >= 0) console.warn(`${LOG_TAG} ${msg}`, ...rest);
  };
  const logDebug = (msg, ...rest) => {
    if (logLevel() >= 2) console.info(`${LOG_TAG} ${msg}`, ...rest);
  };

  // ---- デバッグリングログ ---------------------------------------------------
  // logLevel に係らず常にリングへ記録する。「なぜ飛まないのか」を一度で
  // 掴むための監査証跡。コンソールで:
  //   copy(__chatgptNav.log())   → クリップボードへ全文
  const DBG_MAX = 300;
  const dbgRing = [];
  const dbgBase = Date.now();
  function dbgFmt(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
    return String(v);
  }
  function dbg(evt, ...args) {
    const line = `[+${Date.now() - dbgBase}ms] ${evt}${args.length ? ' ' + args.map(dbgFmt).join(' | ') : ''}`;
    dbgRing.push(line);
    if (dbgRing.length > DBG_MAX) dbgRing.shift();
    logDebug(line);
  }
  function describeEl(el) {
    if (!el) return 'null';
    if (el === document) return 'document';
    let s = String(el.tagName || el.nodeName || '?').toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const c = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (c) s += '.' + c;
    }
    return s;
  }
  function describeScroller(sc) {
    if (!sc) return 'none';
    const conn = sc.isConnected ? '' : '(DETACHED)';
    return `${describeEl(sc)}${conn} sh=${sc.scrollHeight} ch=${sc.clientHeight} st=${sc.scrollTop}`;
  }

  // ---- 状態 --------------------------------------------------------------

  /** 会話順の回答配列（マーカーの並び順 = これ） */
  const items = [];
  /** key → item（キャッシュ本体。DOM 要素は el としてvolatileに持つだけ） */
  const itemsByKey = new Map();
  /** turnKey → ターン自高（data-virtualized-turn の offsetHeight）。
   *  仮想化を跨いで安定する。「間隔のターン高」の引き算専用。 */
  const turnHeights = new Map();

  /** 回答キャッシュ entry
   * { key, turnKey, messageId, preview, scrollPosition, relativePosition,
   *   lastSeen, inDOM, el(volatile: 現在の DOM 参照のみの再取得用) } */

  let conversationId = null;   // 会話識別子（URL の /c/<id>。不明時 null）
  let transcript = null;       // 現在の会話コンテナ要素
  let observedTranscript = null;
  let observer = null;
  let safetyTimer = null;
  let activeKey = null;        // 現在位置マーカー（青色）の key
  let jump = null;            // ジャンプ中状態 {key, phase:'smooth'|'approx', targetScroll, deadline, corrected}
  // trusted ゲート：中断を本物の利用者入力(isTrusted)に限定する（実運用 true）。
  // jsdom は trusted イベントを作れないため、テストではこのスイッチで
  // 「wheel＝中断」の挙動自体を検証する。
  let trustedOnlyCancel = true;
  let warnedNoTranscript = false;

  // ---- ユーティリティ ------------------------------------------------------

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const esc = (s) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  };

  /** ツールチップ表示用のプレビュー（空白圧縮 + 字数上限） */
  function normalizePreview(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
  }

  /** 回答キャッシュのキー */
  function answerKeyOf(turnKey, unitKey, messageId) {
    if (turnKey) return `${turnKey}|${messageId || unitKey || ''}`;
    if (unitKey) return `u:${unitKey}`;
    if (messageId) return `m:${messageId}`;
    return null;
  }

  /** URL（または DOM 属性）から現在の会話IDを取る。非会話ページは null */
  function currentConversationId() {
    const path = window.location.pathname || '';
    const m = path.match(/^\/(?:c|g)\/([^/?#]+)/);
    if (m) return m[1];
    // URL に出ない場合の補助: DOM の会話選択ターゲット
    try {
      const t = document.querySelector(CONV_TARGET_SELECTOR);
      const v = t && t.getAttribute('data-chatgpt-conversation-selection-target');
      if (v) return `dom:${v}`;
    } catch (_) { /* ignore */ }
    return null;
  }

  function topOffset() {
    const vh = window.innerHeight || 800;
    return clamp(vh * 0.15, TOP_OFFSET_MIN, TOP_OFFSET_MAX);
  }

  // ---- スクロールコンテナ --------------------------------------------------

  /** transcript から上位を辿って実際にスクロールできる要素を返す */
  function findScrollContainer() {
    for (let el = transcript ? transcript.parentElement : document.body;
         el && el.nodeType === 1;
         el = el.parentElement) {
      try {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
            el.scrollHeight > el.clientHeight + 1) {
          return el;
        }
      } catch (_) { /* ignore */ }
    }
    const se = document.scrollingElement;
    if (se && se.scrollHeight > se.clientHeight + 1) return se;
    return null;
  }

  let cachedScroller = null;
  function getScroller() {
    if (cachedScroller && cachedScroller.isConnected &&
        cachedScroller.scrollHeight > cachedScroller.clientHeight + 1) {
      return cachedScroller;
    }
    cachedScroller = findScrollContainer();
    if (!cachedScroller) logDebug('scroll container not found');
    return cachedScroller;
  }

  function clampMaxScroll(sc) {
    const max = sc.scrollHeight - sc.clientHeight;
    return Number.isFinite(max) && max > 0 ? max : 0;
  }
  function clampTop(sc, top) {
    return clamp(top, 0, clampMaxScroll(sc));
  }
  /** 回答要素の「スクロール領域内での絶対位置」 */
  function absTop(sc, el) {
    return sc.scrollTop + (el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  }
  function scrollToAbs(sc, top, behavior) {
    try {
      sc.scrollTo({ top, behavior: behavior || 'auto' });
    } catch (_) {
      sc.scrollTop = top; // 旧環境フォールバック
    }
  }

  // ---- 回答検出（DOM 観察） ----------------------------------------------

  function messageIdOf(unit, heading) {
    if (unit) {
      const rb = unit.querySelector(RESPONSE_BODY_SELECTOR);
      if (rb) return rb.getAttribute('data-response-body') || null;
      const sid = unit.querySelector('[data-chatgpt-selection-message-id]');
      if (sid) return sid.getAttribute('data-chatgpt-selection-message-id') || null;
    }
    if (heading) {
      const rb = heading.closest(RESPONSE_BODY_SELECTOR);
      if (rb) return rb.getAttribute('data-response-body') || null;
    }
    return null;
  }

  function previewOf(unit) {
    if (!unit) return '';
    const body = unit.querySelector(RESPONSE_BODY_SELECTOR) ||
               unit.querySelector('[data-markdown-text-style]');
    if (body) return normalizePreview(body.textContent);
    // 本文要素が無い構造のフォールバック：見出し（非表示のacc見出し）を除いたテキスト
    const clone = unit.cloneNode(true);
    clone.querySelectorAll('h4').forEach((h) => h.remove());
    return normalizePreview(clone.textContent);
  }

  /**
   * transcript 内の assistant 回答を DOM 順に収集する。
   * @returns {{units: Array, presentTurnKeys: Set<string>}}
   *   units: DOM 顺の回答情報（未描画は含まれない）
   *   presentTurnKeys: 現在 DOM に存在する全 turn（user のみも含む）の turnKey
   */
  function collectUnits(root) {
    const units = [];
    const presentTurnKeys = new Set();
    if (!root) return { units, presentTurnKeys };

    root.querySelectorAll(TURN_KEY_SELECTOR).forEach((el) => {
      const v = el.getAttribute('data-turn-key');
      if (v) presentTurnKeys.add(v);
    });

    root.querySelectorAll(HEADING_SELECTOR).forEach((heading) => {
      // 回答の着地先は見出しそのものではなく見出しの親＝回答コンテナ
      const unit = heading.parentElement;
      if (!unit || unit === heading) return;
      const turnEl = heading.closest(TURN_KEY_SELECTOR);
      const turnKey = turnEl ? turnEl.getAttribute('data-turn-key') || null : null;
      const unitEl = heading.closest(UNIT_KEY_SELECTOR);
      const unitKey = unitEl ? unitEl.getAttribute('data-content-search-unit-key') || null : null;
      const messageId = messageIdOf(unit, heading);
      const key = answerKeyOf(turnKey, unitKey, messageId);
      if (!key) return; // 識別できない回答は推測で追加しない
      units.push({
        key,
        turnKey,
        unitKey,
        messageId,
        el: unit,
        preview: previewOf(unit),
      });
    });
    return { units, presentTurnKeys };
  }

  // ---- 挿入順 ------------------------------------------------------------

  /**
   * 新回答を会話内の正しい位置に挿入する。
   * 順序根拠は「今回 DOM で観察できた前後の既知回答」。
   * 前後どちらも既知でない場合のみ、スクロール位置を補助として使う。
   * 根拠が無いのに既存の並びを組み替えることはしない。
   */
  function insertOrdered(entry, scanUnits, scanIndex) {
    if (items.length === 0) {
      items.push(entry);
      return;
    }
    let leftKey = null;
    let rightKey = null;
    for (let j = scanIndex - 1; j >= 0; j--) {
      if (itemsByKey.has(scanUnits[j].key) && scanUnits[j].key !== entry.key) {
        leftKey = scanUnits[j].key;
        break;
      }
    }
    for (let j = scanIndex + 1; j < scanUnits.length; j++) {
      if (itemsByKey.has(scanUnits[j].key) && scanUnits[j].key !== entry.key) {
        rightKey = scanUnits[j].key;
        break;
      }
    }
    if (leftKey) {
      const li = items.findIndex((it) => it.key === leftKey);
      items.splice(li >= 0 ? li + 1 : items.length, 0, entry);
      return;
    }
    if (rightKey) {
      const ri = items.findIndex((it) => it.key === rightKey);
      items.splice(ri >= 0 ? ri : 0, 0, entry);
      return;
    }
    // 前後既知なし：スクロール位置で補間（補助）。無意味なら末尾.append
    if (Number.isFinite(entry.scrollPosition)) {
      const at = items.findIndex(
        (it) => Number.isFinite(it.scrollPosition) && it.scrollPosition > entry.scrollPosition + 1
      );
      if (at >= 0) {
        items.splice(at, 0, entry);
        return;
      }
    }
    items.push(entry);
  }

  function removeItem(key) {
    itemsByKey.delete(key);
    const i = items.findIndex((it) => it.key === key);
    if (i >= 0) items.splice(i, 1);
    if (activeKey === key) activeKey = null;
    if (jump && jump.key === key) jump = null;
  }

  // ---- スキャン（coalesce される本体） ------------------------------------

  function findTranscript() {
    return document.querySelector(TRANSCRIPT_SELECTOR);
  }

  /**
   * 会話切り替えを処理する。
   * null→id は「新規チャット作成直後にURLが確定しただけ」なのでitemsadopt（消さない）。
   * id→別id / id→null は実質切り替えなので全消去。
   */
  function handleConversationChange(cid) {
    if (cid === conversationId) return;
    if (conversationId === null && cid !== null) {
      conversationId = cid;
      logDebug('conversation id acquired', cid);
      return;
    }
    logDebug('conversation switched', conversationId, '->', cid);
    const to = cid;
    resetAll();
    conversationId = to;
    startSwitchRescan(to);
  }

  // v0.10.15: 会話切り替え（サイドバー SPA）直後の再スキャン・バースト。
  // 切り替え後 ChatGPT は新会話を非同期に取得・レンダリングするため、
  // スケルトン（回答1件分だけ）で observer が付いたままになり、以降の
  // 全文レンダリングが observer の死角（要素ごと差し替え等）で取り込まれず
  // 「バーが1本だけ」で固まる（実測。F5 では正常）。通常 2s 間隔の保険巡回
  // だけでは遅い/取りこぼすケースがあるため、短間隔で数回強制再走査し、
  // その都度 transcript/observer も取り直す。各ステップの items 数もログに
  // 残し、次回の実機ログで真因（スケルトン表示中 vs observer 死角）を
  // 判別できるようにする。
  const SWITCH_RESCAN_MS = [300, 900, 2000, 4000, 8000];
  function startSwitchRescan(to) {
    SWITCH_RESCAN_MS.forEach((d, i) => {
      setTimeout(() => {
        scanSafely();
        dbg(`conversation rescan #${i + 1}`,
          `conv=${to || 'null'}`, `items=${items.length}`,
          `sc=${describeScroller(getScroller())}`,
          `observed=${!!observedTranscript && observedTranscript === transcript}`);
      }, d);
    });
  }

  function resetAll() {
    dbg('resetAll (clears jump/cache)', `hadJump=${!!jump}`, `items=${items.length}`);
    items.length = 0;
    itemsByKey.clear();
    turnHeights.clear(); // v0.10.15: 旧会話の自高キャッシュを新会話へ漏らさない
    activeKey = null;
    jump = null;
    cachedScroller = null;
    // v0.10.15: 旧 transcript 参照と observer も完全に破棄。
    // 次 scanNow / 再スキャンバーストで取り直す（取り残しで
    // 「1本しか増えない」状態を追えない／直せないのを防ぐ）
    transcript = null;
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    observedTranscript = null;
    clearRows();
  }

  function scanNow() {
    handleConversationChange(currentConversationId());

    const fresh = findTranscript();
    if (!fresh) {
      // 会話画面外／切替直後。全 item を「非在DOM」にするだけ（削除根拠にはしない）
      if (observer) {
        try { observer.disconnect(); } catch (_) {}
        observer = null;
      }
      observedTranscript = null;
      for (const it of items) {
        it.inDOM = false;
        it.el = null;
      }
      if (items.length) {
        renderStates();
      } else if (!warnedNoTranscript && conversationId) {
        warnedNoTranscript = true;
        logWarn('transcript が見つかりません（セレクタ陳腐化の可能性）', TRANSCRIPT_SELECTOR);
      }
      return;
    }
    warnedNoTranscript = false;
    transcript = fresh;

    // observer 付け替え（transcript 自体が差し替わった／初回）
    if (observedTranscript !== transcript) {
      if (observer) {
        try { observer.disconnect(); } catch (_) {}
      }
      observer = null;
      try {
        observer = new MutationObserver(onMutation);
        observer.observe(transcript, { childList: true, subtree: true });
      } catch (_) {
        observer = null;
      }
      observedTranscript = transcript;
    }

    const { units, presentTurnKeys } = collectUnits(transcript);
    const seenKeys = new Set();
    const evicted = [];
    const sc = getScroller();

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      seenKeys.add(u.key);
      // ターン自高キャッシュ（仮想化を跨いで安定。anchor 再推定の材料）
      if (u.turnKey) {
        const tEl = u.el.closest('[data-virtualized-turn]');
        const th = tEl ? tEl.offsetHeight : 0;
        if (th > 0) turnHeights.set(u.turnKey, th);
      }
      const pos = sc && u.el.isConnected
        ? { s: absTop(sc, u.el), r: sc.scrollHeight > 0 ? clamp(absTop(sc, u.el) / sc.scrollHeight, 0, 1) : null }
        : { s: null, r: null };

      const existing = itemsByKey.get(u.key);
      if (existing) {
        if (u.preview) existing.preview = u.preview;
        if (pos.s !== null) {
          existing.scrollPosition = pos.s;
          existing.relativePosition = pos.r;
        }
        existing.lastSeen = Date.now();
        existing.inDOM = true;
        existing.el = u.el;
      } else {
        const entry = {
          key: u.key,
          turnKey: u.turnKey,
          messageId: u.messageId,
          preview: u.preview,
          scrollPosition: pos.s,
          relativePosition: pos.r,
          lastSeen: Date.now(),
          inDOM: true,
          el: u.el,
        };
        itemsByKey.set(u.key, entry);
        insertOrdered(entry, units, i);
      }
    }

    // 今回見えていない item
    for (const it of items.slice()) {
      if (seenKeys.has(it.key)) continue;
      it.inDOM = false;
      it.el = null;
      // 削除根拠：「同一ターンが DOM に残っているのにこの回答だけ存在しない」
      // ＝ 編集・再生成・分岐変更で置き換えられた可能性が高い。
      // 単にターンごと仮想化で見えないだけでは削除しない。
      if (it.turnKey && presentTurnKeys.has(it.turnKey)) {
        evicted.push(it.key);
      }
    }
    for (const k of evicted) removeItem(k);
    if (evicted.length) dbg('answers replaced/removed, cache dropped', evicted.length);
    if (jump) {
      const jItem = itemsByKey.get(jump.key);
      dbg('scan during jump',
        `target=${jItem ? (jItem.inDOM ? 'inDOM' : 'cache-only') : 'GONE'}`,
        `sc=${describeScroller(sc)}`);
    }

    enforceCacheCap();
    ensureRoot();
    renderRows();
    scheduleHighlight();
  }

  function enforceCacheCap() {
    if (itemsByKey.size <= CACHE_MAX) return;
    // 最久未観測かつ非在DOMのものを落とす（在DOMのは絶対に落とさない）
    while (itemsByKey.size > CACHE_MAX) {
      let victim = null;
      for (const it of itemsByKey.values()) {
        if (it.inDOM) continue;
        if (!victim || it.lastSeen < victim.lastSeen) victim = it;
      }
      if (!victim) break;
      logWarn('回答キャッシュ上限超過。最久未観測分を破棄', victim.key);
      removeItem(victim.key);
    }
  }

  // ---- マーカー描画 -------------------------------------------------------

  const rowByKey = new Map(); // key → {row, line}
  let root = null;
  let bar = null;
  let lastSig = '';

  function ensureStyle() {
    if (document.getElementById('cnav-style')) return;
    const st = document.createElement('style');
    st.id = 'cnav-style';
    st.textContent = [
      '#cnav-root{position:fixed;top:14vh;right:20px;z-index:2147483000;',
      'display:flex;flex-direction:column;align-items:flex-end;',
      '--cnav-line:#7a8089;--cnav-cur:#0a84ff;}',
      // ダークモード（ChatGPT は html.dark クラスで切替。OS 設定も一応フォールバック）
      '@media (prefers-color-scheme:dark){#cnav-root{--cnav-line:#9aa1ab;--cnav-cur:#4cc3ff;}}',
      'html.dark #cnav-root{--cnav-line:#9aa1ab;--cnav-cur:#4cc3ff;}',
      'html:not(.dark) #cnav-root{--cnav-line:#7a8089;--cnav-cur:#0a84ff;}',
      '#cnav-bar{display:flex;flex-direction:column;align-items:flex-end;',
      'max-height:' + (BAR_VH * 100).toFixed(0) + 'vh;scrollbar-width:none;}',
      '#cnav-bar::-webkit-scrollbar{display:none;}',
      '.cnav-row{display:flex;justify-content:flex-end;align-items:center;',
      'height:var(--cnav-row-h,14px);width:22px;cursor:pointer;}',
      '.cnav-line{height:2px;width:10px;border-radius:1px;',
      'background:var(--cnav-line);opacity:.7;',
      'transition:opacity .12s ease;pointer-events:none;}',
      '.cnav-line.off{opacity:.3;}',
      '.cnav-row:hover .cnav-line:not(.cur){width:14px;opacity:1;}',
      '.cnav-line.cur{opacity:1;width:18px;background:var(--cnav-cur);}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  function ensureRoot() {
    if (!root) {
      root = document.createElement('div');
      root.id = 'cnav-root';
      bar = document.createElement('div');
      bar.id = 'cnav-bar';
      root.appendChild(bar);
    }
    if (!root.isConnected) {
      (document.body || document.documentElement).appendChild(root);
    }
  }

  function clearRows() {
    if (bar) bar.textContent = '';
    rowByKey.clear();
    lastSig = '';
  }

  /** 構造シグネチャ（キー順 + 在DOM状態）。これが同じなら行の組み替えは不要。
   *  位置情報は含めない — スクロールで位置は変わるがマーカー構造は変わらないため。 */
  function renderSignature() {
    const parts = [];
    for (const it of items) {
      parts.push(`${it.key}:${it.inDOM ? 1 : 0}`);
    }
    return parts.join('\u0001');
  }

  /**
   * 構造（件数・並び・状態）が変わった時だけ行を組み替える。
   * 回答生成中は（本文が伸びても）キー順・状態・位置が同じなら no-op
   * ＝ mutation ↔ 再構築のフィードバックループを断つ。
   */
  function renderRows() {
    if (!bar) return;
    const count = items.length;
    if (count === 0) {
      if (rowByKey.size) clearRows();
      lastSig = '';
      return;
    }

    // 行の高さ：バー高に収まるよう縮小、それでも足りなければ最小高＋バー内スクロール
    const maxH = Math.floor((window.innerHeight || 800) * BAR_VH);
    const rowH = clamp(Math.floor(maxH / count), ROW_MIN_H, ROW_BASE_H);
    const overflowing = count * ROW_MIN_H > maxH;
    bar.style.setProperty('--cnav-row-h', `${rowH}px`);
    bar.style.overflowY = overflowing ? 'auto' : 'hidden';

    const sig = renderSignature();
    if (sig === lastSig) {
      renderStates();
      return;
    }
    lastSig = sig;

    for (const [key, refs] of rowByKey) {
      if (!itemsByKey.has(key)) {
        refs.row.remove();
        rowByKey.delete(key);
      }
    }
    let cursor = null; // 末尾追跡用の直前行
    for (const it of items) {
      let refs = rowByKey.get(it.key);
      if (!refs) {
        const row = document.createElement('div');
        row.className = 'cnav-row';
        row.dataset.key = it.key;
        const line = document.createElement('div');
        line.className = 'cnav-line';
        row.appendChild(line);
        refs = { row, line };
        rowByKey.set(it.key, refs);
      }
      if (cursor === null) {
        if (bar.firstChild !== refs.row) bar.prepend(refs.row);
        cursor = refs.row;
      } else {
        const target = cursor.nextSibling;
        if (target !== refs.row) bar.insertBefore(refs.row, target);
        cursor = refs.row;
      }
    }
    // cursor から後にかつての行が残っていたら撤去（上ループで消えるはずだが保険）
    let n = bar.children.length - items.length;
    while (n-- > 0) {
      bar.lastElementChild && bar.removeChild(bar.lastElementChild);
    }
    renderStates();
  }

  /** 状態（濃淡・青色・ツールチップ）だけ塗り替える低コスト処理 */
  function renderStates() {
    for (const it of items) {
      const refs = rowByKey.get(it.key);
      if (!refs) continue;
      const cls = activeKey === it.key
        ? 'cnav-line cur'
        : it.inDOM
          ? 'cnav-line'
          : 'cnav-line off';
      if (refs.line.className !== cls) refs.line.className = cls;
      const title = it.preview || '（まだ本文がありません）';
      if (refs.row.title !== title) refs.row.title = title;
    }
  }

  // ---- 現在位置ハイライト --------------------------------------------------

  let highlightQueued = false;
  function scheduleHighlight() {
    if (highlightQueued) return;
    highlightQueued = true;
    const tick = () => {
      highlightQueued = false;
      updateActive();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    else setTimeout(tick, 16);
  }

  function updateActive() {
    checkJump();
    const sc = getScroller();
    if (!items.length || !sc) {
      if (activeKey !== null) activeKey = null;
      renderStates();
      return;
    }
    const offset = topOffset();
    const sTop = sc.scrollTop;
    const clientH = sc.clientHeight || window.innerHeight || 800;
    const scrRect = sc.getBoundingClientRect();
    const total = sc.scrollHeight || 0;

    let active = null;
    let bestRel = -Infinity;
    // 実測できる（DOM 在位）回答から判定。ついでにキャッシュ位置を温める
    for (const it of items) {
      if (!it.inDOM || !it.el || !it.el.isConnected) continue;
      const rel = it.el.getBoundingClientRect().top - scrRect.top;
      const s = sTop + rel;
      it.scrollPosition = s;
      if (total > 0) it.relativePosition = clamp(s / total, 0, 1);
      if (rel <= offset && rel > bestRel) {
        bestRel = rel;
        active = it;
      }
    }
    // 在位実測が無ければ、キャッシュのみ回答で「基準線通過直後」の候補を補完。
    // 現在位置から約 2 ビューポート以上離れた推定は誤りがちなので信用しない。
    if (!active) {
      let bestPos = -Infinity;
      for (const it of items) {
        if (it.inDOM || !Number.isFinite(it.scrollPosition)) continue;
        if (it.scrollPosition > sTop + offset) continue;
        if (it.scrollPosition < sTop - 2 * clientH) continue;
        if (it.scrollPosition > bestPos) {
          bestPos = it.scrollPosition;
          active = it;
        }
      }
    }
    const prev = activeKey;
    activeKey = active ? active.key : null;
    renderStates();
    if (activeKey && activeKey !== prev) keepActiveRowVisible();
    // ジャンプ継続中は rAF で張り込みを続ける（最下部拉致の検知・完了判定）。
    // checkJump 側で解決/打ち切りされれば jump が消えてループも止まる
    if (jump) scheduleHighlight();
  }

  /** バー内スクロールでアクティブ行を見える位置に寄せる（バー自身のoverflow） */
  function keepActiveRowVisible() {
    if (!bar || bar.scrollHeight <= bar.clientHeight) return;
    const refs = rowByKey.get(activeKey);
    if (!refs) return;
    const top = refs.row.offsetTop;
    const bottom = top + refs.row.offsetHeight;
    if (top < bar.scrollTop) bar.scrollTop = top;
    else if (bottom > bar.scrollTop + bar.clientHeight) bar.scrollTop = bottom - bar.clientHeight;
  }

  // ---- ジャンプ -----------------------------------------------------------

  function resolveLiveContainer(item) {
    if (item.el && item.el.isConnected) return item.el;
    if (!transcript || !transcript.isConnected) transcript = findTranscript();
    if (!transcript) return null;
    if (item.turnKey) {
      const turn = transcript.querySelector(`[data-turn-key="${esc(item.turnKey)}"]`);
      if (turn) {
        const headings = turn.querySelectorAll(HEADING_SELECTOR);
        if (item.messageId) {
          for (const h of headings) {
            if (messageIdOf(h.parentElement, h) === item.messageId) return h.parentElement;
          }
        } else if (headings.length === 1) {
          return headings[0].parentElement;
        }
      }
    }
    if (item.messageId) {
      const rb = transcript.querySelector(`[data-response-body="${esc(item.messageId)}"]`);
      if (rb) return rb.closest(UNIT_KEY_SELECTOR) || rb.parentElement;
    }
    return null;
  }

  /** 診断用：LIVE 解決に失敗したとき、DOM 上で何が欠けているかを返す */
  function probeLive(item) {
    try {
      if (!transcript || !transcript.isConnected) transcript = findTranscript();
      if (!transcript) return 'probe=no transcript';
      const turnDom = item.turnKey
        ? `turnDom=${!!transcript.querySelector(`[data-turn-key="${esc(item.turnKey)}"]`)}`
        : 'turnDom=(no turnKey)';
      const rbDom = item.messageId
        ? `rbDom=${!!transcript.querySelector(`[data-response-body="${esc(item.messageId)}"]`)}`
        : 'rbDom=(no messageId)';
      const rendered = [...transcript.querySelectorAll(TURN_KEY_SELECTOR)]
        .map((n) => n.getAttribute('data-turn-key'))
        .slice(0, 8)
        .join(',');
      return `${turnDom} ${rbDom} rendered=[${rendered}]`;
    } catch (_) {
      return 'probe=failed';
    }
  }

  /**
   * 仮想化崩壊フレームでも残る3点（会話順 items[]・ターン高キャッシュ・
   * 現在レンダリング済みアンカー）から目標ターンの「絶対位置」を再推定する。
   * cached な abs も rel も上方 culling で数千ズレるが、この3つは安定。
   * @returns {number|null} 推定不可（アンカーなし/間隔ターンの高さ不明）なら null。
   *   平均でごまかすのは誤差が複利で数千pxになるため禁止。
   */
  function guessAbsFromRendered(sc, target) {
    if (!sc || !target || !items.length) return null;
    const tIdx = items.indexOf(target);
    if (tIdx < 0) return null;
    const anchors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === target) continue;
      if (!it.inDOM || !it.el || !it.el.isConnected) continue;
      const tEl = it.el.closest('[data-virtualized-turn]');
      if (!tEl) continue;
      const abs = absTop(sc, tEl);
      if (!Number.isFinite(abs)) continue;
      anchors.push({
        i,
        tk: it.turnKey,
        abs,
        h: tEl.offsetHeight > 0 ? tEl.offsetHeight : (turnHeights.get(it.turnKey) || 0),
      });
    }
    if (!anchors.length) return null;
    anchors.sort((a, b) => a.i - b.i);
    let below = null; // 目標の直下アンカー
    let above = null; // 目標の直上アンカー
    for (const a of anchors) {
      if (a.i < tIdx) below = a;
      else if (a.i > tIdx && above === null) above = a;
    }
    // 目標ターン自身と同一ターン（兄弟回答）のアンカーはそのまま目標位置の最良推定
    if (below && below.tk && below.tk === target.turnKey) return below.abs;
    if (above && above.tk && above.tk === target.turnKey) return above.abs;
    // 境界アンカーと目標ターンの間の間隔ターン高合計。1つでも不明なら null
    const sumGap = (fromIdx, toIdx) => {
      const seen = new Set();
      if (target.turnKey) seen.add(target.turnKey);
      if (below && fromIdx === below.i && below.tk) seen.add(below.tk);
      if (above && fromIdx === above.i && above.tk) seen.add(above.tk);
      let sum = 0;
      for (let i = fromIdx + 1; i < toIdx; i++) {
        const it = items[i];
        if (!it.turnKey) return null;
        if (seen.has(it.turnKey)) continue;
        const h = turnHeights.get(it.turnKey);
        if (!Number.isFinite(h)) return null;
        seen.add(it.turnKey);
        sum += h + TURN_GAP_PX;
      }
      return sum;
    };
    if (below && above) {
      // 挟まれた：高さが揃うなら積み上げ、ダメなら index 補間（位置は
      // アンカーに括束されるので補間は誤差有界で安全）
      const g = sumGap(below.i, tIdx);
      if (g !== null) return below.abs + below.h + TURN_GAP_PX + g;
      const frac = (tIdx - below.i) / (above.i - below.i);
      return below.abs + (above.abs - below.abs) * frac;
    }
    if (below) {
      const g = sumGap(below.i, tIdx);
      if (g === null) return null;
      return below.abs + below.h + TURN_GAP_PX + g;
    }
    if (above) {
      // 目標は全アンカーより上：目標ターン自高が分からないと遡算不能（厳密）
      const tOwn = target.turnKey ? turnHeights.get(target.turnKey) : null;
      if (!Number.isFinite(tOwn)) return null;
      const g = sumGap(tIdx, above.i);
      if (g === null) return null;
      return above.abs - g - tOwn - TURN_GAP_PX;
    }
    return null;
  }

  /**
   * hill-climb re-aim：目標が DOM に未レンダリングのとき、会話順アンカー
   * からの推定位置で再発射する。anchor re-aim は fixes 予算を消費しない
   * （JUMP_MAX_GUESS / JUMP_GUESS_MS の別枠）。rel×maxScroll フォールバック
   * は従来通り 1 jump あたり 1 回限り（reaimed フラグ）。
   * @returns {boolean} re-aim を発射したら true（呼び出し側は return する）
   */
  function tryGuessReaim(j, sc, item, now, tag) {
    if ((j.guesses || 0) >= JUMP_MAX_GUESS) return false;
    if (now - (j.lastGuessAt || 0) < JUMP_GUESS_MS) return false;
    const g = guessAbsFromRendered(sc, item);
    let base = g;
    let src = 'rendered-anchor';
    if (base === null) {
      if (!j.reaimed && Number.isFinite(item.relativePosition)) {
        base = (item.relativePosition || 0) * clampMaxScroll(sc);
        src = 'rel';
      } else {
        return false;
      }
    }
    const target = clampTop(sc, src === 'rel' ? base : base - topOffset());
    if (Math.abs(target - sc.scrollTop) < JUMP_REAIM_MIN_DX) {
      dbg('jump re-aim skipped (already close) [' + (tag || '?') + ']', j.key,
        `src=${src}`, `est=${target}`, `st=${sc.scrollTop}`);
      return false;
    }
    j.guesses = (j.guesses || 0) + 1;
    if (src === 'rel') j.reaimed = true;
    j.lastGuessAt = now;
    const stNow = sc.scrollTop;
    sendScrollIntent(sc, dirOf(sc, target));
    j.lastIntentAt = now;
    scrollToAbs(sc, target, 'auto');
    j.phase = 'approx';
    j.corrected = false;
    j.targetScroll = target;
    j.deadline = now + JUMP_APPROX_MS;
    j.phaseSince = now;
    j.lastSt = stNow;
    j.lastStAt = now;
    j.lastSh = sc.scrollHeight;
    scheduleScan(50);
    dbg('jump re-aim → auto (back to approx)', j.key,
      `tag=${tag || ''}`, `src=${src}`, `guess#${j.guesses}`,
      `st=${stNow}→${target}`, `sh=${sc.scrollHeight}`, `fixes=${j.fixes || 0}`);
    logWarn(
      'jump 位置ずれ→会話順アンカーから再照準（再描画待ち）', j.key,
      `tag=${tag || ''}`, `src=${src}`, `guess#${j.guesses}`, `st=${stNow}→${target}`
    );
    return true;
  }

  /**
   * 意図ホイールの方向：実際の移動方向と一致させる。
   * 嘘の方向（下へ降りるのに「上」意図を出す等）は ChatGPT のホイール
   * 処理が我々のスクロールと矛盾して争い、スクロールが潰される
   * （実測：上方向ジャンプだけ残り下方向は無反応になった）。
   */
  function dirOf(sc, target) {
    return target >= sc.scrollTop ? 1 : -1;
  }

  /**
   * 合成 wheel イベントで「利用者がスクロールした意図」を ChatGPT に示す。
   * 「最新への自動追従」ロジックは利用者の入力無いプログラム的スクロールを
   * 無視して直後に最下部へ引き戻すため、微小なホイールを装う。
   * __cnavIntent マークにより、我々自身の wheel 中断リスナーでは打ち消さない。
   */
  function sendScrollIntent(sc, dir) {
    try {
      const ev = new WheelEvent('wheel', {
        deltaY: dir > 0 ? 2 : -2,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      });
      ev.__cnavIntent = true;
      (sc || window).dispatchEvent(ev);
      logDebug('send user scroll intent (dir=' + (dir > 0 ? 'down' : 'up') + ')');
    } catch (_) {
      // WheelEvent コンストラクタ未対応なら素通し（再発射保険は残る）
    }
  }

  /**
   * @returns {boolean} ジャンプを開始できたか。失敗を成功として返さない。
   *   失敗理由は logWarn（既定 warn レベルでコンソールに見える）に出す。
   */
  function jumpTo(key) {
    const item = itemsByKey.get(key);
    if (!item) {
      logWarn('jumpTo: キャッシュに该当回答が無い', key);
      return false;
    }
    let sc = getScroller();
    if (sc && !sc.isConnected) {
      dbg('jumpTo: cached scroller DETACHED → 再解決');
      cachedScroller = null;
      sc = getScroller();
    }
    if (!sc) {
      logWarn('jumpTo: スクロールコンテナが見つからない（overflow-y 容器の探知失敗？）', key);
      return false;
    }
    if (sc.scrollHeight <= sc.clientHeight + 1) {
      dbg('jumpTo: scroller がスクロール不能（要素誤認の可能性）', describeScroller(sc));
    }

    const el = resolveLiveContainer(item);
    if (el && el.isConnected) {
      // DOM 在位：実測位置へ smooth。先に意図ホイールを発射しておく
      const target = clampTop(sc, absTop(sc, el) - topOffset());
      const t0 = Date.now();
      const start = sc.scrollTop;
      sendScrollIntent(sc, dirOf(sc, target));
      scrollToAbs(sc, target, 'smooth');
      jump = {
        key, phase: 'smooth', targetScroll: target, startScroll: start,
        deadline: t0 + JUMP_SMOOTH_MS, corrected: true,
        issuedAt: t0, phaseSince: t0, reasserted: false, lastIntentAt: t0,
        fixes: 0, reaimed: false, lastSt: start, lastStAt: t0,
        lastSh: sc.scrollHeight, guesses: 0, lastGuessAt: t0,
      };
      dbg('jump start (inDOM smooth)', key,
        `sc=${describeScroller(sc)}`, `el=${describeEl(el)}`,
        `st ${start}→${sc.scrollTop}`, `target=${target}`, `off=${topOffset()}`,
        `dir=${dirOf(sc, target)}`, `max=${clampMaxScroll(sc)}`);
      // 飲み込まれると scroll イベント自体が来ないので、
      // checkJump（ stuck 検知・完了判定）を回す運転手は自分で確保する
      scheduleHighlight();
      return true;
    }
    // キャッシュのみ：記録位置へ instant に飛び、仮想スクロールの再描画を待つ。
    // 記録位置（abs/rel）は仮想化の崩壊フレームで数千ズレる（実測）ため、
    // 会話順アンカーから再推定できるならそれを優先する（v0.10.9）。
    // 記録が全欠落でもアンカー推定だけなら飛べる。
    const g0 = guessAbsFromRendered(sc, item);
    let base;
    let baseSrc;
    if (g0 !== null && Math.abs(g0 - sc.scrollTop) >= JUMP_REAIM_MIN_DX) {
      base = g0;
      baseSrc = 'anchor';
    } else if (Number.isFinite(item.scrollPosition)) {
      base = item.scrollPosition;
      baseSrc = 'pos';
    } else if (Number.isFinite(item.relativePosition)) {
      base = (item.relativePosition || 0) * (sc.scrollHeight || 0);
      baseSrc = 'rel';
    } else {
      logWarn('jumpTo: キャッシュ位置が未記録で飛べない（アンカー推定も不可）', key, item.turnKey, item.messageId);
      return false;
    }
    const target = clampTop(sc, base - topOffset());
    const t0 = Date.now();
    const start = sc.scrollTop;
    sendScrollIntent(sc, dirOf(sc, target));
    scrollToAbs(sc, target, 'auto');
    jump = {
      key, phase: 'approx', targetScroll: target, startScroll: start,
      deadline: t0 + JUMP_APPROX_MS, corrected: false,
      issuedAt: t0, phaseSince: t0, reasserted: false, lastIntentAt: t0,
      fixes: 0, reaimed: false, lastSt: start, lastStAt: t0,
      lastSh: sc.scrollHeight, guesses: 0, lastGuessAt: t0,
    };
    dbg('jump start (cache-only approx)', key,
      `sc=${describeScroller(sc)}`,
      `pos=${item.scrollPosition}`, `rel=${item.relativePosition}`, `base=${base}`, `baseSrc=${baseSrc}`,
      `st ${start}→${sc.scrollTop}`, `target=${target}`,
      `dir=${dirOf(sc, target)}`, `max=${clampMaxScroll(sc)}`);
    if (start === sc.scrollTop) {
      dbg('jump approx: scrollTo 直後にページ未移動（native no-op / Pin？）', start);
    }
    scheduleScan(50);
    scheduleHighlight();
    return true;
  }

  /**
   * 「まだ我々のスクロールが到達していないのに最下部へ吸着している」疑い。
   * ChatGPT 側のグローバルハンドラ（クリック→最新へスクロール等）が
   * 我々のジャンプを打ち消して最下部へ引き戻すケースに対する保険。
   * ※ 利用者の明示入力は cancelJump() で jump 自体が消えるので、ここで再ジャンプ
   *   するのは「無操作のとき」だけ＝手動スクロールと取り合わないことはない。
   */
  function suspiciousBottomSnap(j, sc, now) {
    if (j.reasserted) return false;
    if (!Number.isFinite(j.targetScroll)) return false;
    if (now - (j.phaseSince || j.issuedAt || now) >= JUMP_REASSERT_WINDOW_MS) return false;
    if (now - (j.issuedAt || now) < JUMP_REASSERT_MIN_WAIT_MS) return false;
    const max = clampMaxScroll(sc);
    if (max <= 0) return false;
    const clientH = sc.clientHeight || window.innerHeight || 800;
    // 目標より1ビューポート以上下の「最下部」に今いる → 我々の意図に反する吸着
    return max - sc.scrollTop <= JUMP_SNAP_TOL && max - j.targetScroll > clientH;
  }

  /**
   * 「ジャンプが飲み込まれた」判定：発射から JUMP_STUCK_MIN_MS 経っても
   * scrollTop が発射直前の位置（startScroll）からほぼ動いていないケース。
   * ChatGPT 側のスクロール追従が最初のプログラム的スクロールを無視/Pin する
   * 症状（2回目のクリックなら効く）の自動検知。再発射は拉致保険と
   * 共有の1回限り上限（reasserted）を守る。
   */
  function stuckAtStart(j, sc, now) {
    if (j.reasserted) return false;
    if (!Number.isFinite(j.targetScroll)) return false;
    if (!Number.isFinite(j.startScroll)) return false;
    if (Math.abs(sc.scrollTop - j.targetScroll) <= 3) return false; // 着地済み
    const since = now - (j.phaseSince || j.issuedAt || now);
    if (since < JUMP_STUCK_MIN_MS || since >= JUMP_REASSERT_WINDOW_MS) return false;
    return Math.abs(sc.scrollTop - j.startScroll) <= JUMP_STUCK_TOL;
  }

  /**
   * v0.10.12: 「目標が最新回答でないのにスクロールが最下部に吸着している」判定。
   * ChatGPT の仮想化が崩壊フレームで上部を削ると、その瞬間だけ
   * st == 新max == （クランプされた）目標位置 になり、着地誤判定が起こる。
   * 直後 ChatGPT が下側コンテンツを再拡張して最新回答へ引き戻すため、
   * 下方向ジャンプは「どの位置からでも最新回答へ」症状になる（実測）。
   * 目標が最新回答（items 末尾）なら max 着地は正しいので例外。
   */
  function bottomPulledAtMax(j, sc) {
    const max = clampMaxScroll(sc);
    if (max <= 0) return false;
    if (sc.scrollTop < max - JUMP_SNAP_TOL) return false;
    const last = items.length ? items[items.length - 1] : null;
    if (last && last.key === j.key) return false;
    return true;
  }

  /**
   * v0.10.13: 下端 pull 検知後の二段構え。
   *  1) tryGuessReaim（LIVE アンカー再推定）→ ズレていれば発射して復旧
   *  2) est が現在位置（=max）と変わらず打つ手が無い場合、保留して
   *     jumpTo をまるごと再発射（ChatGPT の再測高待ち。実測で
   *     「もう一回クリックは効く」の自動版）。上限 JUMP_BOTTOM_PULL_REFIRE_MAX。
   * @returns {boolean} true = この場では着地扱いしない（再照準 or 保留中）
   */
  function handleBottomPull(j, sc, item, now, tag) {
    j.lastGuessAt = 0;
    if (tryGuessReaim(j, sc, item, now, tag)) return true;
    if ((j.pullRetries || 0) >= JUMP_BOTTOM_PULL_REFIRE_MAX) {
      // 再発射予算を使い切っても pull が解消しない（ChatGPT がそのフレームで
      // 目標位置を今も末尾と同一視）＝これ以上手なし。黙って max に
      // 「着地/完了」すると最新へ拉致されたままなので、明示的に打ち切る。
      dbg('jump give up at bottom-pull (refire budget exhausted) [' + tag + ']', j.key,
        `st=${sc.scrollTop}`, `max=${clampMaxScroll(sc)}`, `target=${j.targetScroll}`);
      logWarn(
        '下端 pull が再発射でも解消せず打ち切り（最新以外が最下部に吸着）',
        j.key, `st=${sc.scrollTop}`, `max=${clampMaxScroll(sc)}`
      );
      jump = null;
      return true; // Consumed: caller must not fall through to landing
    }
    if (j.pullScheduled) return true; // 予約済み
    const n = (j.pullRetries || 0) + 1;
    const wait = JUMP_BOTTOM_PULL_REFIRE_MS[Math.min(n - 1, JUMP_BOTTOM_PULL_REFIRE_MS.length - 1)];
    const k = j.key;
    dbg('jump bottom-pull hold → 再発射予約 #' + n + ' [' + tag + ']', k,
      `wait=${wait}ms`, `st=${sc.scrollTop}`, `max=${clampMaxScroll(sc)}`, `sh=${sc.scrollHeight}`);
    j.pullRetries = n;
    j.pullScheduled = true;
    j.deadline = now + wait + JUMP_APPROX_MS;
    j.phaseSince = now;
    j.lastSt = sc.scrollTop;
    j.lastStAt = now;
    setTimeout(() => {
      // 保留中に別ジャンプ・中断・消滅したら何もしない
      if (!jump || jump.key !== k) return;
      const ok = jumpTo(k);
      if (ok && jump) {
        jump.pullRetries = n; // 予算は継承（リセットしない）
        dbg('jump bottom-pull 再発射 #' + n + ' [' + tag + ']', k,
          `phase=${jump.phase}`, `target=${jump.targetScroll}`);
      }
    }, wait);
    return true;
  }

  /** マーカー行クリック → jumpTo。bar に対する委譲で、再生成された行でも効く */
  function onRowClick(key) {
    if (!key) {
      logWarn('マーカーをクリックしたが data-key が無い行です');
      return;
    }
    const item = itemsByKey.get(key);
    if (!item) {
      logWarn('マーカーをクリックしたがキャッシュに無い行（古い行）', key);
      return;
    }
    const mode = item.inDOM ? 'inDOM' : 'cache-only';
    const ok = jumpTo(key);
    if (ok) {
      dbg('マーカークリック→ジャンプ開始', key, `mode=${mode}`, `phase=${jump && jump.phase}`);
    }
    // 失敗時は jumpTo 側で logWarn 済み
  }

  /** scan / highlight のたびに呼ぶ。再描画完了→1回だけ補正。時間切れ→打ち切り */
  function checkJump() {
    if (!jump) return;
    const now = Date.now();
    if (now > jump.deadline) {
      dbg('jump TIMEOUT (redraw/landing not detected)', jump.key, jump.phase);
      jump = null;
      return;
    }
    const item = itemsByKey.get(jump.key);
    if (!item) {
      jump = null;
      return;
    }
    const sc = getScroller();
    if (!sc) {
      jump = null;
      return;
    }
    // 被覆窓の間は「利用者の意図」ホイールを間欠的に発射し続ける。
    // これが無いと ChatGPT の最新追従がプログラム的スクロールを
    // 直後に最下部へ引き戻す（冒頭→最下部の反動症状）
    if (
      now - (jump.lastIntentAt || 0) >= JUMP_INTENT_MS &&
      now - (jump.phaseSince || jump.issuedAt || now) <= JUMP_INTENT_COVER_MS
    ) {
      // v0.10.13: 最下部 pull 中は下行意図ホイールが「ユーザーは最新を
      // 見ている」信号になって stick を維持してしまう。pull 検知中だけ
      // 上方向（離脱）意図に切り替えて stick を外す。
      const pulled = bottomPulledAtMax(jump, sc);
      sendScrollIntent(sc, pulled ? -1 : dirOf(sc, jump.targetScroll));
      jump.lastIntentAt = now;
    }
    if (now - (jump.lastTickDbg || 0) >= 50) {
      jump.lastTickDbg = now;
      dbg('jump tick', jump.phase,
        `st=${sc.scrollTop}`, `target=${jump.targetScroll}`,
        `since=${now - (jump.phaseSince || jump.issuedAt || now)}ms`,
        `re=${jump.reasserted ? 1 : 0}`, `fix=${jump.fixes || 0}`, `g=${jump.guesses || 0}`, `sc=${describeScroller(sc)}`);
    }
    // scrollHeight の変化（＝仮想化 reflow の発生）を毎回記録する。
    // shΔ と stΔ の関係が、実機の座標シフト症状の最大の追跡手がかり
    if (jump.lastSh !== undefined && sc.scrollHeight !== jump.lastSh) {
      dbg('jump sh changed', jump.phase,
        `lastSh=${jump.lastSh}→${sc.scrollHeight}`,
        `Δ=${sc.scrollHeight - jump.lastSh}`, `st=${sc.scrollTop}`);
      jump.lastSh = sc.scrollHeight;
    }
    // 発射したのにページが全く動かない（＝最初のスクロールが Pin で無効化）
    // → 意図を添えてもう一発。利用者の「もう一回クリック」を自力でやる
    if (stuckAtStart(jump, sc, now)) {
      jump.reasserted = true;
      const dir = dirOf(sc, jump.targetScroll);
      sendScrollIntent(sc, dir);
      jump.lastIntentAt = now;
      const stBefore = sc.scrollTop;
      scrollToAbs(sc, jump.targetScroll, 'auto');
      let note = 'auto';
      if (Math.abs(sc.scrollTop - stBefore) <= 1) {
        // こちら側の scrollTo がページを動かせない（要素誤認/Pin）→
        // ブラウザネイティブの scrollIntoView に頼る（ ancestry のスクローラを
        // ブラウザ自身が探しにいくので誤認に強い）
        const el2 = resolveLiveContainer(item);
        if (el2 && el2.isConnected) {
          try {
            el2.scrollIntoView({ behavior: 'auto', block: 'start' });
            note = 'auto→scrollIntoView';
          } catch (_) { note = 'auto(scrollIntoView failed)'; }
        } else {
          note = 'auto(no live el for fallback)';
        }
      }
      sendScrollIntent(sc, dir); // 発射後の再 Pin を崩すのでもいいので後追いも一発
      jump.phaseSince = now;
      jump.lastSt = stBefore;
      jump.lastStAt = now;
      logWarn(
        'jump が未実行のようだと検知（スクロールが発射位置から不動）→ 1回だけ再発射',
        jump.key, `phase=${jump.phase}`, `target=${jump.targetScroll}`, `st=${stBefore}→${sc.scrollTop} (${note})`
      );
      return;
    }
    if (jump.phase === 'approx') {
      // 最下部への拉致疑い → 1回だけ記録位置へ再発射（無限リトライはしない）
      if (suspiciousBottomSnap(jump, sc, now)) {
        jump.reasserted = true;
        sendScrollIntent(sc, dirOf(sc, jump.targetScroll));
        jump.lastIntentAt = now;
        scrollToAbs(sc, jump.targetScroll, 'auto');
        jump.phaseSince = now;
        dbg('jump re-assert (approx): 最下部へ拉致された疑いで再発射', jump.key, jump.targetScroll);
        return;
      }
      const el = item.inDOM && item.el && item.el.isConnected
        ? item.el
        : resolveLiveContainer(item);
      if (!el || !el.isConnected) {
        // まだ再描画待ち：材料（アンカー）があれば会話順アンカーで re-aim
        tryGuessReaim(jump, sc, item, now, 'approx');
        return;
      }
      const desired = clampTop(sc, absTop(sc, el) - topOffset());
      if (Math.abs(desired - sc.scrollTop) <= 3) {
        if (bottomPulledAtMax(jump, sc)) {
          // 最下部吸着なのに目標は最新以外 → 崩壊フレーム途中の誤着地。
          // ライブ再推定 or 保留して再発射（v0.10.13）
          if (handleBottomPull(jump, sc, item, now, 'approx-bottom-pull')) return;
        }
        // 補正不要の位置に着いていた
        dbg('jump landed (no correction)', jump.key);
        jump = null;
        return;
      }
      if (jump.corrected) {
        // 補正は1回限り。それでもズレていれば打ち切り（無限リトライ禁止）
        dbg('jump capped after 1 correction (still off)', jump.key, `st=${sc.scrollTop}`, `desired=${desired}`);
        jump = null;
        return;
      }
      jump.corrected = true;
      jump.fixes = (jump.fixes || 0) + 1;
      // 補正は auto（即時）。smooth にすると动画の間に lagi load-more reflow が
      // 入り座標が壊れる（実測 click#4 症状）ので、即時着地が最も安全
      sendScrollIntent(sc, dirOf(sc, desired));
      jump.lastIntentAt = now;
      scrollToAbs(sc, desired, 'auto');
      jump.targetScroll = desired;
      jump.phase = 'smooth';
      jump.deadline = now + JUMP_SMOOTH_MS;
      jump.phaseSince = now;
      // 補正で smooth を新たに走らせるので停滞タイマーもリセット
      // （しないと approx 待機中の古い lastStAt ですぐ誤停滞する）
      jump.lastSt = sc.scrollTop;
      jump.lastStAt = now;
      jump.lastSh = sc.scrollHeight;
      dbg('jump corrected (auto)', jump.key, desired, `fix=${jump.fixes}`);
    } else if (jump.phase === 'smooth') {
      // smooth の途中で最下部へ吸着 → 1回だけ再発射して本来の目標へ戻す。
      // 再発射は auto：再度 smooth にすると反動がまた見えうるので即着地させる
      if (suspiciousBottomSnap(jump, sc, now)) {
        jump.reasserted = true;
        sendScrollIntent(sc, dirOf(sc, jump.targetScroll));
        jump.lastIntentAt = now;
        scrollToAbs(sc, jump.targetScroll, 'auto');
        jump.phaseSince = now;
        dbg('jump re-assert (smooth→auto): 最下部へ拉致された疑いで再発射', jump.key, jump.targetScroll);
        return;
      }
      if (Math.abs(sc.scrollTop - (jump.targetScroll || sc.scrollTop)) <= 3) {
        if (bottomPulledAtMax(jump, sc)) {
          // 目標計算自体がクランプで max に吸着した疑い → 二段構え（v0.10.13）。
          // guesses 残有無に関わらず通す（尽きていれば give up で明示打ち切り）
          if (handleBottomPull(jump, sc, item, now, 'smooth-bottom-pull')) return;
        }
        dbg('jump finished', jump.key, `st=${sc.scrollTop}`);
        jump = null;
        return;
      }
      // smooth 途中フリーズ検知：動きが続く間は監視時刻を更新し続ける。
      // JUMP_STALL_MS 以上ピクリとも動かないうえ目標でもなければ、
      // 保存済み target は仮想化 reflow で死んでいる前提で、
      // LIVE の DOM 実測（要素の現在位置）へ 1 回だけ即補正する。
      if (Math.abs(sc.scrollTop - (jump.lastSt ?? sc.scrollTop)) > JUMP_STALL_TOL) {
        jump.lastSt = sc.scrollTop;
        jump.lastStAt = now;
      } else if (!jump.reasserted && now - (jump.lastStAt || now) >= JUMP_STALL_MS) {
        if ((jump.fixes || 0) >= JUMP_MAX_FIXES) {
          dbg('jump stall-fix budget exhausted → give up', jump.key,
            `fixes=${jump.fixes}`, `st=${sc.scrollTop}`, `target=${jump.targetScroll}`);
          logWarn(
            'jump が複数回停滞し補正予算を使い切ったので打ち切り',
            jump.key, `fixes=${jump.fixes}`, `st=${sc.scrollTop}`
          );
          jump = null;
          return;
        }
        const el2 = resolveLiveContainer(item);
        if (el2 && el2.isConnected) {
          const desired = clampTop(sc, absTop(sc, el2) - topOffset());
          if (Math.abs(desired - sc.scrollTop) <= 3) {
            dbg('jump actually landed (stall re-measure in tol)', jump.key, `st=${sc.scrollTop}`);
            jump = null;
            return;
          }
          jump.fixes = (jump.fixes || 0) + 1;
          sendScrollIntent(sc, dirOf(sc, desired));
          jump.lastIntentAt = now;
          const stNow = sc.scrollTop;
          scrollToAbs(sc, desired, 'auto');
          dbg('jump stall-fix (live re-measure) → auto', jump.key,
            `fix#${jump.fixes}`, `stale-target=${jump.targetScroll}`,
            `st=${stNow}→${desired}`, `sh=${sc.scrollHeight}`);
          jump.targetScroll = desired;
          jump.deadline = now + JUMP_SMOOTH_MS;
          jump.phaseSince = now;
          jump.lastSt = stNow;
          jump.lastStAt = now;
          jump.lastSh = sc.scrollHeight;
          logWarn(
            'jump が途中で停滞（仮想化による座標変化と推定）→ LIVE 実測へ補正',
            jump.key, `fix#${jump.fixes}`, `st=${stNow}→${desired}`
          );
          return;
        }
        // LIVE 対象が DOM に居ない：cached abs は reflow で死んで rel も変わる。
        // 会話順アンカー＋ターン高キャッシュで再推定して re-aim（v0.10.9）
        if (tryGuessReaim(jump, sc, item, now, 'smooth-stall')) return;
        dbg('jump stalled but live target element not found; keep waiting timeout', jump.key,
          `fixes=${jump.fixes || 0}`, `guesses=${jump.guesses || 0}`, probeLive(item));
      }
    }
  }

  /** ユーザーの手動スクロール入力で自動補正を中断する */
  function cancelJump(reason) {
    if (!jump) return;
    dbg('jump CANCEL', reason, jump.key, `st-when-cancelled=${(getScroller() || { scrollTop: '?' }).scrollTop}`);
    jump = null;
  }

  // ---- MutationObserver / イベント -----------------------------------------

  function isOurNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === 'cnav-style') return true;
    return !!root && (node === root || root.contains(node));
  }

  function onMutation(records) {
    let relevant = false;
    for (const r of records) {
      if (isOurNode(r.target)) continue;
      relevant = true;
      break;
    }
    if (relevant) scheduleScan(SCAN_COALESCE_MS);
  }

  let scanTimer = null;
  function scheduleScan(delay) {
    if (scanTimer !== null) return;
    const d = delay === undefined ? SCAN_COALESCE_MS : delay;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanSafely();
    }, d);
  }

  function scanSafely() {
    try {
      scanNow();
    } catch (err) {
      logWarn('scan error', err);
    }
  }

  // ---- 起動 ---------------------------------------------------------------

  function startSafetyLoop() {
    stopSafetyLoop();
    // observer の死角（置換直後等）の保険。画面に無い時は走らせない
    safetyTimer = setInterval(() => {
      if (document.hidden) return;
      scanSafely();
    }, SAFETY_INTERVAL_MS);
  }
  function stopSafetyLoop() {
    if (safetyTimer !== null) {
      clearInterval(safetyTimer);
      safetyTimer = null;
    }
  }

  // ---- UI イベントガード ---------------------------------------------------
  // ChatGPT のグローバルハンドラ（「アプリ内クリック→composer 再フォーカス」
  // 「→最新メッセージへスクロール」等）は、我々の UI 上のクリックも
  // 「アプリ内でのクリック」と解釈して、ジャンプ直後に会話最下部へ引き戻す。
  // document_start でページスクリプトより先に window キャプチャ段の先頭に立ち、
  // 我々の UI に関するポインタ系イベントをここで止めて ChatGPT に一切渡さない。
  const UI_INTERCEPT_EVENTS = [
    'pointerdown', 'mousedown', 'mouseup', 'pointerup',
    'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu',
  ];

  function uiGuard(e) {
    if (!isOurNode(e.target)) return;
    const row = e.type === 'click' && e.target.closest ? e.target.closest('.cnav-row') : null;
    dbg(`ui:${e.type}`, `trusted=${e.isTrusted}`, `key=${row && row.dataset ? row.dataset.key : '(none)'}`);
    // タッチ系で preventDefault すると合成クリックが消えてジャンプできなくなる。
    // フォーカス強奪防止は mouse/pointer(mouse) 側だけで足りる
    const fromTouch =
      (e.type === 'pointerdown' || e.type === 'pointerup') && e.pointerType === 'touch';
    const keepNative = fromTouch || e.type === 'touchstart' || e.type === 'touchend';
    if (e.cancelable && !keepNative) e.preventDefault();
    // 同じノードの後続ハンドラ(window 側の後乗り含む)にも止めを伝える
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else e.stopPropagation();
    if (e.type === 'click') {
      if (row && row.dataset && row.dataset.key) onRowClick(row.dataset.key);
    }
  }

  function installUiGuard() {
    for (const t of UI_INTERCEPT_EVENTS) {
      window.addEventListener(t, uiGuard, { capture: true });
    }
  }

  // ---- ショートカットジャンプ（Alt+↑/↓ ＝ 1つ上/下の回答冒頭、Alt+K/J 別名）----
  // Ctrl/Cmd はダウンロード・omnibox・タブ切替・選択拡張・入力欄の段落移動など
  // ブラウザ既定と構造的に衝突するため使わない。Alt は本拡張の「非干渉モディファイア」。
  // ジャンプ機構自体は jumpTo（キャッシュ＋アンカー再実測）をそのまま再利用するので、
  // 仮想化された長会話でも連打で何件でも歩き続けられる。

  const SHORTCUT_JUMP_KEYS = {
    ArrowUp: 'prev',
    ArrowDown: 'next',
    k: 'prev',
    j: 'next',
  };

  /**
   * この keydown がジャンプショートカットかどうか。
   * @returns {'prev'|'next'|null} Ctrl/Cmd/Shift の併用と IME 変換中は対象外。
   */
  function shortcutDir(e) {
    if (!e || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
    if (e.isComposing) return null; // IME 変換中は横取りしない
    const k = typeof e.key === 'string' ? e.key : '';
    if (Object.prototype.hasOwnProperty.call(SHORTCUT_JUMP_KEYS, k)) return SHORTCUT_JUMP_KEYS[k];
    if (k.length === 1) return SHORTCUT_JUMP_KEYS[k.toLowerCase()] || null;
    return null;
  }

  /**
   * dir 方向の隣回答キーを返す。
   * 基準は jump 中なら jump.key（＝向かっている回答）、そうでなければ
   * activeKey（青マーカー）の会話順インデックスに対する ±1。
   * ジャンプ中は activeKey がまだ古いので、jump.key 基準にしないと
   * 連打が同じ回答を再目標化して歩かない。
   * 基準キーが無い時は記録位置からの近似：
   *   prev ＝ ビューポート上端より上に記録開始がある最後の回答
   *   next ＝ ビューポート下端より下に記録開始がある最初の回答
   * 端（隣が無い）は折返しせず null（＝no-op）。
   * v0.10.14: prev で基準回答の冒頭がアンカーラインより上（画面外）なら、
   * 1つ前ではなく基準回答自身の冒頭を返す（読み途中から「まず冒頭へ」）。
   */
  /**
   * v0.10.14: 回答の冒頭が現在アンカーラインより上（＝画面外かヘッダーに
   * 隠れている）かどうか。長い回答の途中を読んでいて冒頭が見えないとき、
   * Alt+↑ の目標を「1つ前」でなく「その回答自身（の冒頭）」にする判定。
   * DOM 在位ならライブ実測、無ければ記録位置（scrollPosition）で近似する。
   * 既に冒頭見え位置（± JUMP_CURRENT_TOP_TOL）なら false → 通常どおり 1つ前へ。
   */
  function topAboveAnchor(item) {
    if (!item) return false;
    const sc = getScroller();
    if (!sc) return false;
    const line = sc.scrollTop + topOffset();
    if (item.inDOM && item.el && item.el.isConnected) {
      const scrRect = sc.getBoundingClientRect();
      const abs = item.el.getBoundingClientRect().top - scrRect.top + sc.scrollTop;
      return abs < line - JUMP_CURRENT_TOP_TOL;
    }
    const p = item.scrollPosition;
    if (!Number.isFinite(p)) return false;
    return p < line - JUMP_CURRENT_TOP_TOL;
  }

  function neighborKey(dir) {
    if (!items.length) return null;
    const baseKey = (jump && jump.key) || activeKey;
    if (baseKey) {
      const idx = items.findIndex((it) => it.key === baseKey);
      if (idx >= 0) {
        if (dir === 'prev' && topAboveAnchor(items[idx])) return baseKey;
        const nb = dir === 'prev' ? items[idx - 1] : items[idx + 1];
        return nb ? nb.key : null;
      }
    }
    const sc = getScroller();
    if (!sc) return null;
    const top = sc.scrollTop;
    const bottom = top + (sc.clientHeight || window.innerHeight || 800);
    if (dir === 'prev') {
      for (let i = items.length - 1; i >= 0; i--) {
        const p = items[i].scrollPosition;
        if (Number.isFinite(p) && p < top) return items[i].key;
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        const p = items[i].scrollPosition;
        if (Number.isFinite(p) && p > bottom) return items[i].key;
      }
    }
    return null;
  }

  function onShortcutKeydown(e) {
    const dir = shortcutDir(e);
    if (!dir) return;
    if (e.cancelable !== false) e.preventDefault(); // Windows の Alt メニュー発火などを抑止
    // この keydown はページ側へ一切渡さない。ChatGPT や他拡張が Alt+矢印などに
    // グローバルハンドラを持っていた場合、我々のジャンプと取り合って
    // 最下部（最新回答）へ引き戻す可能性があるため。
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else e.stopPropagation();
    // ホールドによるキーオートリピート（約30発/秒）は丸ごと無視。
    // 連鎖歩行を許すと目標の上書きが秒あたり数十回走り、下方向では
    // キャッシュ末尾＝最新回答まで突き抜けて「1つ下」が制御不能になる
    // （実測の「どの位置からでも最新へ」の元凶）。
    // 物理的な 1 プッシュ = 1 ホップ。連打での步行は従来通り。
    if (e.repeat) {
      dbg('shortcut ignore (autorepeat)', dir);
      return;
    }
    const key = neighborKey(dir);
    if (!key) {
      dbg('shortcut no-op', dir, `items=${items.length}`, `active=${activeKey}`);
      return;
    }
    const idx = items.findIndex((it) => it.key === key);
    const baseKey = (jump && jump.key) || activeKey;
    const selfTop = dir === 'prev' && key === baseKey;
    dbg('shortcut jump', dir, `idx=${idx}`, `key=${key}`, `from=${activeKey}`,
      selfTop ? '(self top: 冒頭が画面外→自身の冒頭へ)' : '');
    jumpTo(key);
  }

  function attachEvents() {
    // 中断に採用するのは「本物の入力」(isTrusted) だけ。
    // ChatGPT は入れ子スクローラからホイールを再ディスパッチ（転送）する
    // ことがあり、我々の合成意図ホイールや自前のスクロール再現が
    // 「マークなしの untrusted wheel」として戻ってくることがある。
    // それを「ユーザー操作」として扱うとジャンプ開始直後に自分自身で
    // 中断してしまい、下方向ジャンプが全く動かない症状になった
    // （実測：上方向は OK / 下方向は無反応）。利用者の実入力は trusted なので　
    // 「手動スクロールで中断」要件はそのまま成立する。
    window.addEventListener('wheel', (e) => {
      if (jump) {
        dbg('wheel seen (jump active)',
          `trusted=${e && e.isTrusted}`, `marked=${!!(e && e.__cnavIntent)}`,
          `dy=${e && e.deltaY}`, `tgt=${describeEl(e && e.target)}`);
      }
      if (e && e.__cnavIntent) return; // 我々の合成意図ホイール
      if (trustedOnlyCancel && !e.isTrusted) return; // 転送・模倣など合成イベント
      cancelJump('wheel');
    }, { capture: true, passive: true });
    window.addEventListener('touchstart', (e) => {
      if (jump) {
        dbg('touch seen (jump active)',
          `trusted=${e && e.isTrusted}`, `marked=${!!(e && e.__cnavIntent)}`,
          `tgt=${describeEl(e && e.target)}`);
      }
      if (e && e.__cnavIntent) return;
      if (trustedOnlyCancel && !e.isTrusted) return;
      cancelJump('touch');
    }, { capture: true, passive: true });
    // ジャンプ中はスクロールイベントを全て記録（誰がどこを動かしたか）。
    // document スクロールは e.target===document になるので滚动要素に読み替える
    document.addEventListener('scroll', (e) => {
      if (!jump) return;
      const t = e.target === document ? (document.scrollingElement || document.documentElement) : e.target;
      if (t && t.id === 'cnav-bar') return; // バー自身の内部スクロールは無視
      dbg('scroll evt', describeEl(t), `st=${t && typeof t.scrollTop === 'number' ? t.scrollTop : '?'}`);
    }, { capture: true, passive: true });
    // ショートカットジャンプは中断より先に登録する（preventDefault を先に出す）。
    window.addEventListener('keydown', onShortcutKeydown, { capture: true });
    window.addEventListener('keydown', (e) => {
      // 隣回答ジャンプのキーは「手動入力＝中断」に数えない。
      // 数えると同一イベント内で、自分が発射したジャンプを
      // 自分で打ち消す（Alt+矢印の e.key は 'ArrowDown' 等だから）。
      if (shortcutDir(e)) return;
      if (JUMP_CANCEL_KEYS.has(e.key)) cancelJump(`key:${e.key}`);
    }, { capture: true });
    window.addEventListener('resize', () => {
      cachedScroller = null;
      scheduleScan(120);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopSafetyLoop();
      else {
        startSafetyLoop();
        scheduleScan(50);
      }
    });
  }

  function start() {
    ensureStyle();
    ensureRoot();
    attachEvents();
    startSafetyLoop();
    scheduleScan(0);
    dbg('nav init', `v${NAV_VERSION}`, 'world=MAIN run_at=document_start', `href=${window.location.href}`);
    logDebug(`v${NAV_VERSION} 読み込み完了 (world=MAIN, run_at=document_start)`);
  }

  // UI ガードは body の有無と無関係に、スクリプト評価の早い段階で仕込む
  // （document_start 注入＝ページ本体より先に window キャプチャ段を取れる）
  installUiGuard();

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // ---- 診断・テスト用入口 --------------------------------------------------

  const strip = (it) => ({
    key: it.key,
    turnKey: it.turnKey,
    messageId: it.messageId,
    preview: it.preview,
    scrollPosition: it.scrollPosition,
    relativePosition: it.relativePosition,
    lastSeen: it.lastSeen,
    inDOM: it.inDOM,
  });

  const api = {
    version: NAV_VERSION,
    scan: scanSafely,
    highlight: () => {
      updateActive();
      return activeKey;
    },
    jumpTo,
    jumpState: () => (jump
      ? {
        key: jump.key, phase: jump.phase, corrected: jump.corrected,
        reasserted: jump.reasserted, stallFixed: (jump.fixes || 0) > 0,
        fixes: jump.fixes || 0, reaimed: !!jump.reaimed,
        guesses: jump.guesses || 0,
        pullRetries: jump.pullRetries || 0,
        targetScroll: jump.targetScroll, startScroll: jump.startScroll,
      }
      : null),
    snapshot: () => ({
      conversationId,
      activeKey,
      items: items.map(strip),
    }),
    internals: {
      normalizePreview,
      answerKeyOf,
      currentConversationId,
      topOffset,
      clampTop,
      insertOrdered,
      itemsOrdered: items,
      turnHeights, // ターン自高キャッシュ（デバッグ/テスト用）
      TURN_GAP_PX,
      guessAbsFromRendered,
      itemsByKey, // デバッグ用：キャッシュの実体（テストでも使用）
      setTrustedOnlyCancel: (v) => { trustedOnlyCancel = Boolean(v); },
    },
    // ---- デバッグ用：リングログ（copy(__chatgptNav.log()) でコピペ） ----
    log: () => dbgRing.join('\n'),
    clearLog: () => { dbgRing.length = 0; },
  };
  window.__chatgptNav = api;
})();
