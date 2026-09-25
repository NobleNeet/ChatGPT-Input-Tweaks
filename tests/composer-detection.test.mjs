/**
 * ChatGPT Enter Key — 入力欄判定（isComposerInput）の静的・自動テスト
 *
 * 実行: node tests/composer-detection.test.mjs   （または npm test）
 * 依存: jsdom（devDependency）。実ブラウザは使わない。
 *
 * 何を検めるか
 *   - 受理されるべき DOM（現行構造 / role・aria-multiline を削除した将来構造 /
 *     composer コンテナ内部 / 近傍に prompt fallback）が `accepted: true` になること
 *   - 拒否されるべき DOM（非表示 fallback / 検索欄 / CodeMirror / Monaco / [role=code] /
 *     hidden・aria-hidden / 別目的 input / 一般の contenteditable）が `accepted: false` になること
 *   - `role="textbox"` / `aria-multiline="true"` の有無だけで合否が変わらないこと
 *     （＝ARIA 属性への必須依存が無いこと、ARIA だけを見て受理する経路が無いこと）
 *   - content.js が読み込まれ、自己診断が投げずに返ること／判定中にログを出さないこと
 *
 * jsdom は `isContentEditable` と `getClientRects()` を実装していないため、
 * テスト側でブラウザの挙動を再現している（実装コードは触らない）。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'chatgpt-enter-key');
const CONTENT_SRC = readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

// ---- jsdom 補強: 実ブラウザに近い挙動 ------------------------------------

// contenteditable 属性の継承（既定は false、'false' で打ち消し、'inherit' は祖を見る）
function computeIsContentEditable(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (!node.hasAttribute('contenteditable')) continue;
    const value = (node.getAttribute('contenteditable') || '').trim().toLowerCase();
    if (value === '' || value === 'true') return true;
    if (value === 'false') return false;
    // 'inherit' は親を続ける
  }
  return false;
}

// display:none / visibility:hidden / [hidden] のいずれかが祖に含まれれば描画されていない
function computeRendered(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute && node.hasAttribute('hidden')) return false;
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function patchBrowserGaps(w) {
  Object.defineProperty(w.Element.prototype, 'isContentEditable', {
    configurable: true,
    get() {
      return computeIsContentEditable(this);
    },
  });

  const rects = function getClientRects() {
    return computeRendered(this) ? [{ width: 12, height: 12, top: 0, left: 0 }] : [];
  };
  try {
    w.Element.prototype.getClientRects = rects;
  } catch (_) {
    Object.defineProperty(w.Element.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: rects,
    });
  }
}

function captureConsole(w) {
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const record = (...args) => {
      logs.push({ level, text: args.map((a) => String(a && a.message ? a.message : a)).join(' ') });
    };
    try {
      w.console[level] = record;
    } catch (_) {
      /* 差し替え不可なら素通し */
    }
  }
  return logs;
}

function loadExtension() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://chatgpt.com/',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  });
  patchBrowserGaps(dom.window);
  const logs = captureConsole(dom.window);
  dom.window.eval(CONTENT_SRC);
  return { w: dom.window, doc: dom.window.document, logs };
}

// ---- 固定句（現行 DOM サンプルと、改版で変わりそうな DOM） ----------------

// 現行構造: ID・旧コンテナ・fallback はない。class と aria-label は判定根拠にしない。
const CURRENT = `
  <form class="relative flex flex-col gap-2" data-composer-placement="home"
        data-chatgpt-composer="" data-thread-find-composer="true">
    <div contenteditable="true" aria-multiline="true" role="textbox"
         class="ProseMirror" data-composer-markdown="" aria-label="ChatGPT に聞く"
         data-virtualkeyboard="true"><p><br></p></div>
    <button type="button" aria-label="停止"></button>
    <button type="submit" aria-label="送信">送信</button>
  </form>`;

// 旧構造（docs/chatgpt-dom-sample.txt の旧サンプル相当）。
const LEGACY = `
  <div id="composer" data-testid="composer">
    <div class="wcDTda_prosemirror-parent text-token-text-primary">
      <textarea name="prompt-textarea" aria-label="ChatGPT とチャットする" style="display: none;"></textarea>
      <div id="prompt-textarea" contenteditable="true" class="ProseMirror"
           role="textbox" aria-multiline="true"><p><br></p></div>
    </div>
  </div>`;

// 改版後その1: role / aria-multiline が消えた
const FUTURE_NO_ARIA = `
  <div id="composer" data-testid="composer">
    <div class="wcDTda_prosemirror-parent">
      <textarea name="prompt-textarea" style="display: none;"></textarea>
      <div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div>
    </div>
  </div>`;

// 改版後その2: コンテナの data-testid も消えた（fallback は同親に残る）
const FUTURE_NO_TESTID = `
  <div class="wrapper">
    <div class="wcDTda_prosemirror-parent">
      <textarea name="prompt-textarea" style="display: none;"></textarea>
      <div contenteditable="true" class="ProseMirror"><p><br></p></div>
    </div>
  </div>`;

// 改版後その3: fallback が 1 つ外側のラッパーへ移動した（近傍ウィンドウの内側）
const FUTURE_FALLBACK_ONE_UP = `
  <div class="outer">
    <textarea name="prompt-textarea" style="display: none;"></textarea>
    <div class="inner">
      <div contenteditable="true" class="ProseMirror"><p><br></p></div>
    </div>
  </div>`;

// 近傍ウィンドウの外: fallback が遠すぎるとこの根拠は効かない（誤検知防止の上限）
const FALLBACK_TOO_FAR = `
  <div class="outer">
    <textarea name="prompt-textarea" style="display: none;"></textarea>
    <div class="l1"><div class="l2"><div class="l3">
      <div contenteditable="true" class="ProseMirror"><p><br></p></div>
    </div></div></div>
  </div>`;

// composer と同じページに同居する、無関係な本文側編集域
const COMPOSER_AND_COMMENT = `
  ${CURRENT}
  <div class="comment-box">
    <div contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div>
  </div>`;
const LEGACY_COMPOSER_AND_COMMENT = `
  <div id="composer" data-testid="composer">
    <div class="wcDTda_prosemirror-parent">
      <textarea name="prompt-textarea" style="display: none;"></textarea>
      <div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div>
    </div>
  </div>
  <div class="comment-box">
    <div contenteditable="true" role="textbox" aria-multiline="true"><p><br></p></div>
  </div>`;

// composer とは無関係な一般的な contenteditable（ARIA 属性が揃っていても拒否）
const GENERIC = `
  <div class="comment-box">
    <div contenteditable="true" class="editor" role="textbox" aria-multiline="true"><p><br></p></div>
  </div>`;
const GENERIC_NO_ARIA = GENERIC.replace(' role="textbox" aria-multiline="true"', '');

// ARIA 属性だけを外した差分（「ARIA 属性への必須依存が無いこと」の検査用）
function withoutAria(html) {
  return html.replace(/ role="textbox"/g, '').replace(/ aria-multiline="true"/g, '');
}


// 受理されるべきケース
export const ACCEPT_CASES = [
  { name: '現行構造: data-chatgpt-composer 内の contenteditable（ID・fallback なし）', html: CURRENT, find: 'div[contenteditable="true"]', expect: true },
  { name: '旧構造: #prompt-textarea + contenteditable + ARIA', html: LEGACY, find: '#prompt-textarea', expect: true },
  { name: '現行コンテナ内は class・aria-label なしでも受理', html: '<form data-chatgpt-composer><div contenteditable="true"></div></form>', find: 'div[contenteditable="true"]', expect: true },
  { name: '旧 data-test-id コンテナも受理', html: '<div data-test-id="composer"><div contenteditable="true"></div></div>', find: 'div[contenteditable="true"]', expect: true },
  { name: '将来構造: #prompt-textarea + contenteditable（ARIA 削除）', html: FUTURE_NO_ARIA, find: '#prompt-textarea', expect: true },
  { name: '将来構造: ARIA 削除 + data-testid 削除（fallback 同親）', html: FUTURE_NO_TESTID, find: 'div.ProseMirror', expect: true },
  { name: '将来構造: ARIA 削除 + fallback が 1 階層上のラッパー', html: FUTURE_FALLBACK_ONE_UP, find: 'div.ProseMirror', expect: true },
  {
    name: 'composer コンテナ内部の contenteditable（ID・ARIA・fallback なし）',
    html: '<div data-testid="composer"><div contenteditable="true"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: true,
  },
  {
    name: 'composer コンテナ内部で role のみ（aria-multiline 欠落）',
    html: '<div id="composer"><div contenteditable="true" role="textbox"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: true,
  },
  {
    name: 'composer コンテナ内部で aria-multiline のみ（role 欠落）',
    html: '<div id="composer"><div contenteditable="true" aria-multiline="true"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: true,
  },
  {
    name: '.composer-sender 内部の contenteditable',
    html: '<div class="composer-sender"><div contenteditable="true"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: true,
  },
  {
    name: '近傍に fallback がある contenteditable（composer コンテナなし）',
    html: '<div><textarea name="prompt-textarea" style="display:none"></textarea><div contenteditable="true"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: true,
  },
  {
    name: '旧 textarea 構成: 可視 textarea + 送信ボタンのある form',
    html: '<form><textarea name="prompt"></textarea><button data-testid="compose-send-button"></button></form>',
    find: 'textarea',
    expect: true,
  },
];

// 拒否されるべきケース（誤検知防止が落ちていないことの回帰検査）
export const REJECT_CASES = [
  { name: '非表示 fallback textarea 自体', html: LEGACY, find: 'textarea[name="prompt-textarea"]', expect: false },
  { name: 'ARIA が揃っていても composer と無関係な contenteditable', html: GENERIC, find: 'div.editor', expect: false },
  { name: 'ARIA なし・composer と無関係な contenteditable', html: GENERIC_NO_ARIA, find: 'div.editor', expect: false },
  {
    name: 'composer と同じページに同居する本文側編集域（fallback を拾わない）',
    html: COMPOSER_AND_COMMENT,
    find: 'div.comment-box > div[contenteditable="true"]',
    expect: false,
  },
  {
    name: '旧 composer と同じページの一般編集域も拒否',
    html: LEGACY_COMPOSER_AND_COMMENT,
    find: 'div.comment-box > div[contenteditable="true"]',
    expect: false,
  },
  {
    name: '近傍ウィンドウ外の fallback（遠すぎる）は強い根拠にしない',
    html: FALLBACK_TOO_FAR,
    find: 'div.ProseMirror',
    expect: false,
  },
  {
    name: 'CodeMirror（.cm-content）は composer 内部でも拒否',
    html: '<div id="composer"><div contenteditable="true" class="cm-content" role="textbox" aria-multiline="true"></div></div>',
    find: 'div.cm-content',
    expect: false,
  },
  {
    name: 'Monaco Editor 内部の編集域',
    html: '<div class="monaco-editor"><div contenteditable="true" role="textbox" aria-multiline="true"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: false,
  },
  {
    name: '[role=code] は composer 内部でも拒否',
    html: '<div id="composer"><div contenteditable="true" role="code"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: false,
  },
  {
    name: '検索欄 input[type=search]',
    html: '<div><input type="search" name="q"></div>',
    find: 'input[type="search"]',
    expect: false,
  },
  {
    name: '検索欄 [role=searchbox]（contenteditable でも拒否）',
    html: '<div id="composer"><div contenteditable="true" role="searchbox"></div></div>',
    find: 'div[contenteditable="true"]',
    expect: false,
  },
  {
    name: 'aria-hidden の #prompt-textarea は強い ID より除外を優先',
    html: '<div id="composer"><div id="prompt-textarea" contenteditable="true" aria-hidden="true"></div></div>',
    find: '#prompt-textarea',
    expect: false,
  },
  {
    name: '非表示（display:none）の #prompt-textarea',
    html: '<div id="composer"><div id="prompt-textarea" contenteditable="true" style="display:none"></div></div>',
    find: '#prompt-textarea',
    expect: false,
  },
  {
    name: '別目的 input（password）',
    html:
      '<form><input type="password"><input type="number"><input type="tel">' +
      '<input type="url"><input type="email"><button data-testid="compose-send-button"></button></form>',
    find: 'input[type="password"]',
    expect: false,
  },
  {
    name: 'Canvas 要素（編集域ではない）',
    html: '<div id="composer"><canvas width="10" height="10"></canvas></div>',
    find: 'canvas',
    expect: false,
  },
  {
    name: '可視の name=prompt-textarea fallback は除外',
    html: '<form><textarea name="prompt-textarea"></textarea><button data-testid="compose-send-button"></button></form>',
    find: 'textarea[name="prompt-textarea"]',
    expect: false,
  },
  {
    name: '送信ボタンのない form の可視 textarea',
    html: '<form><textarea name="comment"></textarea></form>',
    find: 'textarea',
    expect: false,
  },
  {
    name: '#prompt-textarea でも contenteditable でない要素',
    html: '<div id="composer"><div id="prompt-textarea"><p>text</p></div></div>',
    find: '#prompt-textarea',
    expect: false,
  },
];

// ---- 実行 ----------------------------------------------------------------

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
}

function mountFixture(doc, html) {
  doc.body.innerHTML = ''; // 前ケースの DOM が祖先走査（fallback 探索）に混線しないよう空にする
  const wrap = doc.createElement('div');
  wrap.innerHTML = html;
  doc.body.appendChild(wrap);
  return wrap;
}

const { w, doc, logs } = loadExtension();
// 判定中にログが出ないことを確認するため、診断ログ自体は静音化する
w.localStorage.setItem('chatgptEnterKeyLogLevel', 'off');

// 0) 注入完了と版数の一致（README の確認手順と同じ）
check(
  'content.js が注入され、__chatgptEnterKeyVersion が manifest.json と一致する',
  String(w.__chatgptEnterKeyVersion) === MANIFEST.version,
  `content.js=${w.__chatgptEnterKeyVersion} manifest=${MANIFEST.version}`
);

// 1) 受理／拒否の受け入れ基準
for (const c of [...ACCEPT_CASES, ...REJECT_CASES]) {
  const wrap = mountFixture(doc, c.html);
  const el = wrap.querySelector(c.find);
  if (!el) {
    check(`${c.expect ? '受理' : '拒否'}: ${c.name}`, false, `固定句に要素が見つからない (${c.find})`);
    continue;
  }
  const res = w.__chatgptEnterKeyProbe(el);
  check(
    `${c.expect ? '受理' : '拒否'}: ${c.name}`,
    res.accepted === c.expect,
    `accepted=${res.accepted} / evidence=${JSON.stringify(res.evidence)}`
  );
}

// 2) ARIA 属性（role / aria-multiline）の有無で合否が変わらないこと
for (const c of ACCEPT_CASES) {
  const stripped = withoutAria(c.html);
  if (stripped === c.html) continue; // もともと ARIA 属性を持たない固定句
  const wrap = mountFixture(doc, stripped);
  const el = wrap.querySelector(c.find);
  const res = el ? w.__chatgptEnterKeyProbe(el) : { accepted: false, evidence: null };
  check(
    `ARIA を消しても受理される: ${c.name}`,
    res.accepted === true,
    `accepted=${res.accepted} / ariaRich=${res.evidence && res.evidence.ariaRich}`
  );
}

// 3) 将来構造（ARIA 属性なし）での根拠の内訳
{
  const wrap = mountFixture(doc, FUTURE_NO_ARIA);
  const res = w.__chatgptEnterKeyProbe(wrap.querySelector('#prompt-textarea'));
  const ev = res.evidence || {};
  check(
    '将来構造の根拠: ariaRich=false でも promptId / fallback / container が立つ',
    res.accepted === true &&
      ev.ariaRich === false &&
      ev.promptId === true &&
      ev.inComposerContainer === true &&
      ev.promptFallbackNearby === true,
    JSON.stringify(ev)
  );
}

// 4) 自己診断が投げずに返り、根拠の内訳を含むこと
{
  mountFixture(doc, CURRENT);
  let report = null;
  let thrown = null;
  try {
    report = w.__chatgptEnterKeySelfTest();
  } catch (err) {
    thrown = err;
  }
  check(
    '自己診断（__chatgptEnterKeySelfTest）が投げずに composerEvidence を返す',
    !thrown && report && Array.isArray(report.composer) && Boolean(report.composerEvidence),
    thrown ? String(thrown && thrown.message) : `probes=${report && report.composer.length}`
  );

  // 5) 選択文字列からも探れる（README の GUI 確認手順）
  const bySelector = w.__chatgptEnterKeyProbe('form[data-chatgpt-composer] [contenteditable="true"]');
  check(
    '現行 DOM の自己診断は ID・fallback 不在でも composer と送信ボタンを捕捉する',
    bySelector.accepted === true && bySelector.evidence.promptId === false &&
      bySelector.evidence.promptFallbackNearby === false &&
      bySelector.evidence.inComposerContainer === true &&
      report.composerElement === doc.querySelector('[data-chatgpt-composer] [contenteditable="true"]') &&
      report.sendButton.via === 'selector' && report.sendButton.selector === 'button[aria-label="送信"]',
    JSON.stringify({ evidence: bySelector.evidence, sendButton: report.sendButton })
  );
}

// 6) 判定処理自体がログを出さないこと（ログレベル off で無出力のはず）
{
  const before = logs.length;
  const wrap = mountFixture(doc, LEGACY);
  w.__chatgptEnterKeyProbe(wrap.querySelector('#prompt-textarea'));
  w.__chatgptEnterKeyProbe(wrap.querySelector('textarea[name="prompt-textarea"]'));
  check(
    '入力欄判定の呼び出しでコンソールログが増えないこと',
    logs.length === before,
    `追加ログ=${logs.length - before}`
  );
}

// 7) 現行 DOM からのキー操作と送信ボタン探索
function keyFixture() {
  const fixture = loadExtension();
  fixture.w.localStorage.setItem('chatgptEnterKeyLogLevel', 'off');
  fixture.w.localStorage.setItem('chatgptEnterKeyVerify', '0');
  mountFixture(fixture.doc, CURRENT + '<form><button type="submit" id="unrelated-submit">別フォーム</button></form>');
  fixture.doc.querySelector('[data-chatgpt-composer]').addEventListener('submit', (event) => event.preventDefault());
  return {
    ...fixture,
    editor: fixture.doc.querySelector('[data-chatgpt-composer] [contenteditable="true"]'),
    send: fixture.doc.querySelector('[data-chatgpt-composer] button[aria-label="送信"]'),
    stop: fixture.doc.querySelector('[data-chatgpt-composer] button[aria-label="停止"]'),
    unrelated: fixture.doc.querySelector('#unrelated-submit'),
  };
}

function dispatchEnterEvent(fixture, type, options = {}) {
  const event = new fixture.w.KeyboardEvent(type, {
    key: 'Enter', bubbles: true, cancelable: true, ...options,
  });
  fixture.editor.dispatchEvent(event);
  return event;
}

function dispatchEnter(fixture, options = {}) {
  return dispatchEnterEvent(fixture, 'keydown', options);
}

for (const modifier of ['ctrlKey', 'metaKey']) {
  const f = keyFixture();
  const clicks = { send: 0, stop: 0, unrelated: 0 };
  for (const name of Object.keys(clicks)) f[name].addEventListener('click', () => { clicks[name] += 1; });

  let pageFollowups = 0;
  f.w.addEventListener('keypress', () => { pageFollowups += 1; });
  f.w.addEventListener('keyup', () => { pageFollowups += 1; });

  const event = dispatchEnter(f, { [modifier]: true });
  const keypress = dispatchEnterEvent(f, 'keypress', { [modifier]: true });
  const keyup = dispatchEnterEvent(f, 'keyup', { [modifier]: true });
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    `${modifier === 'ctrlKey' ? 'Ctrl' : 'Cmd'}+Enter は送信だけ行い、対応する keypress / keyup を ChatGPT 側へ流さない`,
    event.defaultPrevented && keypress.defaultPrevented && keyup.defaultPrevented &&
      stats.send === 1 && stats.sendFollowupStopped === 2 && clicks.send === 1 &&
      clicks.stop === 0 && clicks.unrelated === 0 && pageFollowups === 0,
    JSON.stringify({ stats, clicks, pageFollowups })
  );
}

{
  const f = keyFixture();
  f.send.disabled = true;
  let stopClicks = 0;
  let unrelatedClicks = 0;
  f.stop.addEventListener('click', () => { stopClicks += 1; });
  f.unrelated.addEventListener('click', () => { unrelatedClicks += 1; });
  const event = dispatchEnter(f, { ctrlKey: true });
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    '送信ボタンが無効なら Stop や別フォームの submit をクリックしない',
    !event.defaultPrevented && stats.send === 0 && stopClicks === 0 && unrelatedClicks === 0,
    JSON.stringify({ stats, stopClicks, unrelatedClicks })
  );
}

{
  const f = keyFixture();
  let seenShift = null;
  f.editor.addEventListener('keydown', (event) => { seenShift = event.shiftKey; });
  const event = dispatchEnter(f);
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    'Enter 単独は現行 DOM で Shift+Enter に変換して委任',
    !event.defaultPrevented && seenShift === true && stats.enterNewline === 1 && stats.send === 0,
    JSON.stringify({ seenShift, stats })
  );
}

{
  const f = keyFixture();
  const event = dispatchEnter(f, { shiftKey: true });
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    'Shift+Enter は素通し',
    !event.defaultPrevented && event.shiftKey === true &&
      stats.shiftPassthrough === 1 && stats.enterNewline === 0 && stats.send === 0,
    JSON.stringify(stats)
  );
}

{
  const f = keyFixture();
  const event = dispatchEnter(f, { isComposing: true });
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    'IME 変換中の Enter は素通し',
    !event.defaultPrevented && !event.shiftKey && stats.imeSkip === 1 &&
      stats.enterNewline === 0 && stats.send === 0,
    JSON.stringify(stats)
  );
}

{
  const f = keyFixture();
  f.editor.dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true }));
  const event = dispatchEnter(f, { ctrlKey: true });
  const stats = f.w.__chatgptEnterKeyStats();
  check(
    'compositionstart 中の Ctrl+Enter は送信しない',
    !event.defaultPrevented && stats.imeSkip === 1 && stats.send === 0,
    JSON.stringify(stats)
  );
}

// ---- 結果 ----------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.pass && r.detail) console.log(`      ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} 件成功`);

// 拡張の自己診断ループ（requestAnimationFrame）が生きているので明示的に終了する
process.exit(failed === 0 ? 0 : 1);



