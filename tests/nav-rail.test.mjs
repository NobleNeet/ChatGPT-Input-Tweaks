/**
 * ChatGPT Nav Rail — 会話ナビゲーションバー（nav.js）の静的・自動テスト
 *
 * 実行: node tests/nav-rail.test.mjs   （または npm test）
 * 依存: jsdom（devDependency）。実ブラウザは使わない。
 *
 * 何を検めるか
 *   - 検出: h4[data-conversation-role="assistant"] から
 *     「見出しの親＝回答コンテナ」をキー（turnKey|messageId）付きで拾えること
 *   - キャッシュ: 仮想化で DOM から消えた回答は inDOM=false として残り、
 *     再出現で inDOM=true に戻ること（削除は「同一ターンが残って该当回答だけ無い」時だけ）
 *   - 並び順: 会話内の回答順が維持され、後から発見した回答が前後関係で正しく挿入されること
 *   - 会話切り替え: 別会話のキャッシュを混在させないこと
 *   - ジャンプ: DOM在位は smooth、キャッシュのみは approx→再描画後に1回だけ補正、
 *     ユーザー入力で中断、失敗を成功と返さないこと
 *   - ハイライト: 基準線を最後に通過した回答が active（.cur クラス）になること
 *
 * jsdom にはレイアウトが無いので、スクロール位置系は
 * getBoundingClientRect / scrollTop / scrollHeight をテスト側でスタブして再現する
 * （実装コードは触らない）。実ブラウザでの見た目は README §8 の手動確認のこと。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'chatgpt-enter-key');
const NAV_SRC = readFileSync(path.join(EXT_DIR, 'nav.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

// ---- 検証ヘルパ -----------------------------------------------------------

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
}

// ---- jsdom 補強: レイアウトのスタブ --------------------------------------

function stubRect(el, top, height = 60) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top,
      left: 0,
      right: 100,
      bottom: top + height,
      width: 100,
      height,
      x: 0,
      y: top,
    }),
  });
}

/** offsetHeight スタブ（jsdom はレイアウト計算しないので常時 0） */
function stubHeight(el, h) {
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
}

/** スクロール可能要素のスタブ。scrollTo の呼び出しを記録する */
function makeScroller(el, { scrollHeight = 2000, clientHeight = 800 } = {}) {
  el.style.overflowY = 'auto';
  let st = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => st,
    set: (v) => {
      st = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  const calls = [];
  el.scrollTo = (opts) => {
    calls.push(opts);
    if (opts && typeof opts.top === 'number') {
      st = Math.max(0, Math.min(opts.top, scrollHeight - clientHeight));
    }
  };
  stubRect(el, 0, clientHeight);
  return calls;
}

// ---- 会話 DOM ビルダー ----------------------------------------------------

/**
 * @param {Array<{turnKey:string, answers:Array<{msg?:string, text:string}>}>} turns
 *   spec の 2026-11 DOM 概略と同じ階層で組む。
 *   回答コンテナ = h4 の親（data-content-search-unit-key を持つ div）。
 */
function transcriptHTML(turns) {
  return `<div data-rail-chat-transcript="true" class="contents">
      <div class="relative shrink-0" style="height: 15768px;">
        <div class="flex flex-col">${turns.map(turnHTML).join('')}</div>
      </div>
    </div>`;
}

function turnHTML(t) {
  const units = t.answers
    .map(
      (a, i) => `
          <div data-content-search-unit-key="${t.turnKey}:${i * 2}:assistant">
            <h4 data-conversation-role="assistant"></h4>
            <div data-response-body="${a.msg || `${t.turnKey}-body-${i}`}">
              <div data-markdown-text-style="assistant-message">${a.text}</div>
            </div>
          </div>`
    )
    .join('');
  return `
      <div data-virtualized-turn style="height: 600px; margin-top: 0px;">
        <div data-turn-key="${t.turnKey}">
          <div data-content-search-turn-key="${t.turnKey}">
            <div>
              <h4 data-conversation-role="user"></h4>
              <div data-user-message-bubble="true">${t.turnKey}の質問</div>
            </div>
            ${units}
          </div>
        </div>
      </div>`;
}

// ---- ロード ---------------------------------------------------------------

function loadNav(url = 'https://chatgpt.com/c/aaa') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  });
  const w = dom.window;
  w.localStorage.setItem('chatgptNavLogLevel', 'off');
  w.eval(NAV_SRC);
  return { dom, w, doc: w.document, nav: w.__chatgptNav };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 会話本体を scroller 配下に組み、scroller と unit 要素にレイアウトをスタブする */
function mount(f, turns) {
  return mountWith(f, 2000, 800, turns);
}

function mountWith(f, scrollHeight, clientHeight, turns) {
  f.doc.body.innerHTML = `<div id="scroller">${transcriptHTML(turns)}</div>`;
  const calls = makeScroller(f.doc.getElementById('scroller'), { scrollHeight, clientHeight });
  return calls;
}

const snapItems = (nav) => nav.snapshot().items;

// ======================================================================
// 0) 注入とバージョン
// ======================================================================
{
  const f = loadNav();
  check(
    'nav.js が注入され、__chatgptNav.version が manifest.json と一致する',
    f.nav && String(f.nav.version) === MANIFEST.version,
    `nav=${f.nav && f.nav.version} manifest=${MANIFEST.version}`
  );
  f.dom.window.close();
}

// ======================================================================
// 1) 純関数: プレビュー / キー / 会話ID
// ======================================================================
{
  const f = loadNav('https://chatgpt.com/c/abc123');
  const it = f.nav.internals;

  check(
    'normalizePreview: 空白圧縮 + 字数上限',
    it.normalizePreview('  a\n\n  b   c  ') === 'a b c' &&
      it.normalizePreview('x'.repeat(500)).length === 180,
    JSON.stringify({ collapsed: it.normalizePreview('  a\n\n  b   c  ') })
  );
  check(
    'answerKeyOf: turnKey + messageId が同一ターン内複数回答で別キーになる',
    it.answerKeyOf('T1', 'U1', 'M1') !== it.answerKeyOf('T1', 'U2', 'M2') &&
      it.answerKeyOf('T1', 'U1', 'M1') === it.answerKeyOf('T1', 'U1', 'M1') &&
      it.answerKeyOf(null, null, null) === null,
    JSON.stringify([
      it.answerKeyOf('T1', 'U1', 'M1'),
      it.answerKeyOf('T1', 'U2', 'M2'),
    ])
  );
  check(
    'currentConversationId: URL の /c/<id> を拾う',
    it.currentConversationId() === 'abc123',
    String(it.currentConversationId())
  );
  f.dom.window.close();
}

// ======================================================================
// 2) 検出: 2ターン3回答のキー・プレビュー・inDOM
// ======================================================================
{
  const f = loadNav();
  mount(f, [
    {
      turnKey: 'T1',
      answers: [
        { msg: 'M1', text: '第一の回答です。今日はいい天気ですね。' },
        { msg: 'M2', text: '第二の回答（同一ターン内）' },
      ],
    },
    { turnKey: 'T2', answers: [{ msg: 'M3', text: '第三の回答' }] },
  ]);
  f.nav.scan();
  const items = snapItems(f.nav);

  check('3回答が検出される', items.length === 3, JSON.stringify(items.map((i) => i.key)));
  check(
    '見出しの親（回答コンテナ）単位で、turnKey と messageId が取れている',
    items[0].turnKey === 'T1' && items[0].messageId === 'M1' &&
      items[1].messageId === 'M2' && items[2].turnKey === 'T2',
    JSON.stringify(items.map((i) => [i.turnKey, i.messageId]))
  );
  check(
    'プレビューは回答本文の冒頭',
    items[0].preview.startsWith('第一の回答です'),
    String(items[0].preview)
  );
  check('検出直後は全て inDOM=true', items.every((i) => i.inDOM === true));
  f.dom.window.close();
}

// ======================================================================
// 3) 仮想化: 消えてもキャッシュは残り、再出現で戻る
// ======================================================================
{
  const f = loadNav();
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  f.nav.scan();
  check('初期検出 2件', snapItems(f.nav).length === 2);

  // T1 が仮想化で DOM から消える（T2 のみ）
  mount(f, [{ turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二（更新）' }] }]);
  f.nav.scan();
  const after = snapItems(f.nav);
  check(
    '仮想化で消えた回答のキャッシュは削除されず inDOM=false になる',
    after.length === 2 && after.some((i) => i.turnKey === 'T1' && i.inDOM === false),
    JSON.stringify(after.map((i) => [i.turnKey, i.inDOM]))
  );
  check(
    '見えている回答は inDOM=true が維持される',
    after.some((i) => i.turnKey === 'T2' && i.inDOM === true)
  );
  check(
    '薄いグレー（.off）クラスが着く',
    f.doc.querySelector('.cnav-row[data-key^="T1|"] .cnav-line').classList.contains('off')
  );
  check(
    '見えている回答は通常グレー（.off なし）',
    !f.doc.querySelector('.cnav-row[data-key^="T2|"] .cnav-line').classList.contains('off')
  );

  // T1 が再び DOM に出現 → inDOM: true / .off 解消
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  f.nav.scan();
  const back = snapItems(f.nav);
  check(
    '再出現で inDOM=true に戻る',
    back.some((i) => i.turnKey === 'T1' && i.inDOM === true)
  );
  check(
    '.off が解消される',
    !f.doc.querySelector('.cnav-row[data-key^="T1|"] .cnav-line').classList.contains('off')
  );
  f.dom.window.close();
}

// ======================================================================
// 4) 並び順: 後から上に現れた回答は正しく前へ挿入される
// ======================================================================
{
  const f = loadNav();
  mount(f, [
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  f.nav.scan();
  check(
    'T2, T3 の順でキャッシュ',
    snapItems(f.nav).map((i) => i.turnKey).join(',') === 'T2,T3',
    snapItems(f.nav).map((i) => i.turnKey).join(',')
  );

  // 上にスクロールして T1 が新たに可視化（T2 と同時に DOM に見える）
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  f.nav.scan();
  check(
    '後発の T1 が既知の T2 より前（DOMの前後関係どおり）に挿入される',
    snapItems(f.nav).map((i) => i.turnKey).join(',') === 'T1,T2,T3',
    snapItems(f.nav).map((i) => i.turnKey).join(',')
  );

  // 並びは安定（再スキャンで崩れない）
  f.nav.scan();
  check(
    '再スキャンで並び順が変わらない',
    snapItems(f.nav).map((i) => i.turnKey).join(',') === 'T1,T2,T3'
  );
  f.dom.window.close();
}

// ======================================================================
// 5) 削除検出: 同一ターンが残る中で回答だけ消えたらキャッシュ破棄
// ======================================================================
{
  const f = loadNav();
  mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  f.nav.scan();
  check('T1/M1 が1件', snapItems(f.nav).length === 1);

  // 回答が再生成され messageId が差し替わった（ターンは DOM に残存）
  mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1-reborn', text: '再生成された回答' }] }]);
  f.nav.scan();
  const items = snapItems(f.nav);
  check(
    'ターンが残る中で回答だけ消えた場合、旧キャッシュは破棄され新回答だけになる',
    items.length === 1 && items[0].messageId === 'M1-reborn',
    JSON.stringify(items.map((i) => [i.turnKey, i.messageId]))
  );

  // ターンごと仮想化で消えた場合は破棄しない（=3番で確認済み、ここでは逆に「ターン不在=保持」を念押し）
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  check(
    'ターンごと消えた（編集置換が確認できない）キャッシュは保持される',
    snapItems(f.nav).length === 1 && snapItems(f.nav)[0].messageId === 'M1-reborn'
  );
  f.dom.window.close();
}

// ======================================================================
// 6) 会話切り替え
// ======================================================================
{
  const f = loadNav('https://chatgpt.com/c/one');
  mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '会話1の回答' }] }]);
  f.nav.scan();
  check('会話1で1件', snapItems(f.nav).length === 1);

  f.dom.window.history.pushState({}, '', '/c/two');
  mount(f, [{ turnKey: 'T9', answers: [{ msg: 'M9', text: '会話2の回答' }] }]);
  f.nav.scan();
  const items = snapItems(f.nav);
  check(
    '会話切り替えで別会話のキャッシュは消え、新会話の回答だけになる',
    items.length === 1 && items[0].turnKey === 'T9' && f.nav.snapshot().conversationId === 'two',
    JSON.stringify({ items, cid: f.nav.snapshot().conversationId })
  );

  // 新規チャット: 送信前は cid=null で検出 → 送信で /c/<id> 確定時も消えない
  const g = loadNav('https://chatgpt.com/');
  mount(g, [{ turnKey: 'N1', answers: [{ msg: 'NM1', text: '最初の質問の回答' }] }]);
  g.nav.scan();
  check('cid=null で検出できる', snapItems(g.nav).length === 1 && g.nav.snapshot().conversationId === null);
  g.dom.window.history.pushState({}, '', '/c/freshly-created');
  g.nav.scan();
  check(
    'cid=null→実ID は「同じ会話の継続」として adopt（マーカーが消えない）',
    snapItems(g.nav).length === 1 && snapItems(g.nav)[0].turnKey === 'N1' &&
      g.nav.snapshot().conversationId === 'freshly-created',
    JSON.stringify(g.nav.snapshot())
  );
  g.dom.window.close();
  f.dom.window.close();
}

// ======================================================================
// 7) 位置キャッシュ（スクロール位置・相対位置）
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  const unit1 = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  const unit2 = f.doc.querySelector('[data-turn-key="T2"] [data-content-search-unit-key]');

  // scrollTop=500 のとき、T1 の上端がスクロール領域内で 800px の位置
  const scroller = f.doc.getElementById('scroller');
  scroller.scrollTop = 500;
  stubRect(unit1, 300, 60); // abs = 500 + 300 = 800
  stubRect(unit2, 700, 60); // abs = 1200
  f.nav.scan();
  const a = snapItems(f.nav)[0];
  check(
    'scrollPosition = scrollTop + レクト相対',
    a.scrollPosition === 800,
    String(a.scrollPosition)
  );
  check(
    'relativePosition = 全体(scrollHeight)に対する相対',
    a.relativePosition === 0.4,
    String(a.relativePosition)
  );
  void calls;
  f.dom.window.close();
}

// ======================================================================
// 8) ジャンプ: DOM在位は smooth
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  const scroller = f.doc.getElementById('scroller');
  scroller.scrollTop = 200;
  stubRect(unit, 900, 60); // abs=1100, offset=115.2 → target ≈ 984.8
  f.nav.scan();
  const key = snapItems(f.nav)[0].key;
  const ok = f.nav.jumpTo(key);
  const off = f.nav.internals.topOffset();
  check('DOM在位のジャンプは true を返す', ok === true);
  check('smooth スクロールが1回発行される', calls.length === 1 && calls[0].behavior === 'smooth');
  check(
    '目標 = 実測位置 − 見出しオフセット',
    Math.abs(calls[0].top - (1100 - off)) <= 0.01,
    `top=${calls[0].top} expected=${1100 - off}`
  );
  f.dom.window.close();
}

// ======================================================================
// 9) ジャンプ: キャッシュのみ → approx → 再描画後に1回だけ補正
// ======================================================================
{
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  const unit1 = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  const scroller = f.doc.getElementById('scroller');
  scroller.scrollTop = 0;
  stubRect(unit1, 1300, 60); // abs = 1300 に記録
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  const cachedPos = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').scrollPosition;
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  check('キャッシュ位置記録', cachedPos === 1300, String(cachedPos));

  // T1 を仮想化で消してジャンプ → approx（記録位置へ instant）
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  const before = calls.length;
  const ok = f.nav.jumpTo(key);
  check('キャッシュのみ回答のジャンプも true', ok === true);
  const approxCall = calls[before];
  check(
    'approx: 記録位置−オフセット へ auto で飛ぶ',
    approxCall && approxCall.behavior === 'auto' &&
      Math.abs(approxCall.top - (1300 - off)) <= 0.01,
    JSON.stringify(approxCall)
  );
  check('approx 状態である', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');
  const stBefore = scroller.scrollTop; // approx 着地位置

  // 仮想スクロールが再描画し、T1 が「scrollTop+200」の位置に現れた
  const transcriptEl = f.doc.querySelector('[data-rail-chat-transcript="true"]');
  transcriptEl.querySelector('.flex').insertAdjacentHTML(
    'afterbegin',
    turnHTML({ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] })
  );
  const reinserted = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  stubRect(reinserted, 200, 60); // scroller viewport に対し相対 200 → abs = stBefore+200
  f.nav.scan(); // 再出現を.cache に反映（inDOM=true / 位置更新）
  check(
    'scan で再出現が inDOM=true に戻る',
    f.nav.snapshot().items.find((i) => i.key === key).inDOM === true
  );
  f.nav.highlight(); // ここで checkJump → 補正 scrollTo が入る
  const corr = calls[calls.length - 1];
  check(
    '再出現後、実測位置へ1回の補正 auto スクロール（v0.10.8: smooth ではない）',
    corr && corr !== approxCall && corr.behavior === 'auto' &&
      Math.abs(corr.top - (stBefore + 200 - off)) <= 0.01,
    JSON.stringify({ corr, stBefore, off })
  );
  check(
    '補正は1回だけ（同じ補正を繰り返さない）',
    calls.filter((c) => c !== approxCall && c.behavior === 'auto').length === 1,
    JSON.stringify(calls)
  );

  // 補正完了 → jump 解除（scrollTo が top を実現しているので highlight で終わる）
  f.nav.highlight();
  check('補正完了後 jump 解除', f.nav.jumpState() === null);
  f.dom.window.close();
}

// ======================================================================
// 10) ジャンプ: 再描画が来なければ時間切れで打ち切る（無限リトライしない）
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = snapItems(f.nav)[0].key;
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  const before = calls.length;
  f.nav.jumpTo(key);
  check('approx 発進', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');

  // 再描画が来ないまま highlight を回しても、スクロール発行は増えない
  f.nav.highlight();
  f.nav.highlight();
  check(
    '再描画なしの間、スクロール発行は増えない（無限リトライ禁止）',
    calls.length === before + 1,
    `calls=${calls.length} before=${before}`
  );

  // 再描画が来ないまま deadline を経過 → 打ち切り（失敗をぶら下げない）
  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow + 999999;
  f.nav.highlight();
  check('deadline 超過で jump 打ち切り', f.nav.jumpState() === null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ======================================================================
// 11) ジャンプ: ユーザーの手動スクロールで中断
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-turn-key="T1"] [data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = snapItems(f.nav)[0].key;
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  f.nav.jumpTo(key);
  check('ジャンプ中', f.nav.jumpState() !== null);
  // trusted ゲート ON（既定）: 合成 (isTrusted=false) wheel では中断しない。
  // ChatGPT がホイールを再ディスパッチ（転送）して「ユーザー操作」もどきで
  // 返ってくる対策。実利用者の wheel は trusted なので従来の要件は維持。
  const synth = new f.w.WheelEvent('wheel', { deltaY: 5, deltaMode: 0, bubbles: true });
  f.w.dispatchEvent(synth);
  check('合成（untrusted）wheel では中断しない', f.nav.jumpState() !== null);
  // ゲート OFF（jsdom は trusted を作れないためスイッチで実入力相当を再現）
  f.nav.internals.setTrustedOnlyCancel(false);
  f.w.dispatchEvent(new f.w.Event('wheel'));
  check('wheel で中断', f.nav.jumpState() === null);

  // PageDown でも中断
  f.nav.jumpTo(key);
  const kd = new f.w.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true });
  f.w.dispatchEvent(kd);
  check('PageDown でも中断', f.nav.jumpState() === null);
  void calls;
  f.dom.window.close();
}

// ======================================================================
// 12) 失敗を成功と返さない
// ======================================================================
{
  const f = loadNav();
  check('存在しないキーへの jumpTo は false', f.nav.jumpTo('no-such-key') === false);
  f.dom.window.close();
}

// ======================================================================
// 13) 現在位置ハイライト: 基準線を最後に通過した回答が .cur
// ======================================================================
{
  const f = loadNav();
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  const [u1, u2, u3] = f.doc.querySelectorAll('[data-content-search-unit-key]');
  const scroller = f.doc.getElementById('scroller');
  f.nav.scan();
  const off = f.nav.internals.topOffset();

  // scrollTop=1000: T1 は abs 800（通過済, rel=-200）, T2 は 1000（rel=0 ≤ off → 通過の最新）, T3 は 1600（未通過）
  scroller.scrollTop = 1000;
  stubRect(u1, -200, 60);
  stubRect(u2, 0, 60);
  stubRect(u3, 600, 60);
  const active = f.nav.highlight();
  check(
    '基準線を最後に通過した T2 が active',
    active && active.startsWith('T2|'),
    String(active)
  );
  const cur = f.doc.querySelector('.cnav-line.cur');
  check(
    '.cur クラスが T2 の行に付く',
    cur && cur.parentElement.dataset.key.startsWith('T2|'),
    String(cur && cur.parentElement.dataset.key)
  );

  // さらにスクロールして T3 が通過 → T3 へ
  scroller.scrollTop = 1550;
  stubRect(u2, -450, 60);
  stubRect(u3, 30, 60); // rel=30 ≤ off
  const active2 = f.nav.highlight();
  check(
    'スクロール進めると T3 が active',
    active2 && active2.startsWith('T3|'),
    String(active2)
  );

  // どの回答も基準線より下なら active なし（＝誤った強調をしない）
  scroller.scrollTop = 0;
  stubRect(u1, 500, 60);
  stubRect(u2, 600, 60);
  stubRect(u3, 700, 60);
  check('全回答が基準線より下なら active なし', f.nav.highlight() === null);
  f.dom.window.close();
}

// ======================================================================
// 14) ツールチップ
// ======================================================================
{
  const f = loadNav();
  mount(f, [
    {
      turnKey: 'T1',
      answers: [{ msg: 'M1', text: 'これはツールチップに表示される回答冒頭のテキストです。' }],
    },
  ]);
  f.nav.scan();
  const row = f.doc.querySelector('.cnav-row');
  check('ホバー用 title に回答冒頭', (row && row.title || '').startsWith('これはツールチップ'));
  f.dom.window.close();
}

// ======================================================================
// 15) 描画の再利用: 同一構造で再スキャンしても行を組み替えない
// ======================================================================
{
  const f = loadNav();
  mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  f.nav.scan();
  const row1 = f.doc.querySelector('.cnav-row');
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 400, 60);
  f.nav.scan(); // 同じ構造のまま
  const row2 = f.doc.querySelector('.cnav-row');
  check(
    '構造不変なら行要素を生成し直さない（同じ要素を再利用）',
    row1 && row1 === row2,
    `${row1 === row2}`
  );
  f.dom.window.close();
}

// ======================================================================
// 16) マーカークリック（回帰: handler 未配線でクリックが無反応だった）
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  const scroller = f.doc.getElementById('scroller');
  scroller.scrollTop = 0;
  stubRect(unit, 900, 60);
  f.nav.scan();
  const off = f.nav.internals.topOffset();

  const row = f.doc.querySelector('.cnav-row');
  row.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check(
    'マーカークリック: inDOM → smooth スクロールが発生する',
    calls.length === 1 && calls[0].behavior === 'smooth' &&
      Math.abs(calls[0].top - (900 - off)) <= 0.01,
    JSON.stringify(calls)
  );

  // イベント target が線(.cnav-line)側でも closest 委譲で拾える
  const before = calls.length;
  const line = row.querySelector('.cnav-line');
  line.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check(
    'イベント target が線側でも closest で拾ってジャンプする',
    calls.length === before + 1,
    JSON.stringify(calls.slice(before))
  );

  // 行以外（bar 自身）をクリック → 無反応
  const before2 = calls.length;
  f.doc
    .getElementById('cnav-bar')
    .dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('行以外クリックではジャンプしない', calls.length === before2);
  f.dom.window.close();
}

// ======================================================================
// 17) キャッシュのみマーカーをクリック（approx ジャンプ）
// ======================================================================
{
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  const row = f.doc.querySelector('.cnav-row'); // 薄いグレーの行は残っている
  check('キャッシュのみ行もクリック可能（DOM に存在する）', !!row);
  row.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  check(
    'キャッシュのみマーカーをクリック → approx(auto) ジャンプ',
    calls.length >= 1 && calls[calls.length - 1].behavior === 'auto' &&
      Math.abs(calls[calls.length - 1].top - (1500 - off)) <= 0.01,
    JSON.stringify(calls)
  );
  check('クリック後 approx 状態', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');
  f.dom.window.close();
}

// ======================================================================
// 18) UI イベントガード（回帰: バーのクリックが ChatGPT のグローバルハンドラに
//     伝播し、「composer 再フォーカス→最新へスクロール」でジャンプ直後に
//     会話最下部へ引き戻されていた）
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 900, 60);
  f.nav.scan();
  const off = f.nav.internals.topOffset();

  // ChatGPT のグローバルハンドラ風スパイ（※nav より後に登録 = 実環境と同じ順序）
  const seen = { winCap: 0, docBubble: 0, winBubble: 0 };
  f.w.addEventListener('click', () => { seen.winCap += 1; }, true);
  f.doc.addEventListener('click', () => { seen.docBubble += 1; });
  f.w.addEventListener('click', () => { seen.winBubble += 1; });

  const row = f.doc.querySelector('.cnav-row');
  const md = new f.w.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  const ck = new f.w.MouseEvent('click', { bubbles: true, cancelable: true });
  const before = calls.length;
  row.dispatchEvent(md);
  row.dispatchEvent(ck);

  check(
    'クリックは従来どおりジャンプする（ガード経由）',
    calls.length === before + 1 && calls[calls.length - 1].behavior === 'smooth' &&
      Math.abs(calls[calls.length - 1].top - (900 - off)) <= 0.01,
    JSON.stringify(calls)
  );
  check(
    'mousedown は preventDefault 済み（フォーカス強奪で composer に走らせない）',
    md.defaultPrevented === true
  );
  check('後乗り window capture もクリックを見ない', seen.winCap === 0);
  check('後乗り document bubble もクリックを見ない', seen.docBubble === 0);
  check('後乗り window bubble もクリックを見ない', seen.winBubble === 0);

  // 我々の UI 以外のクリックは普通に通過する（ガードは UI 以外に触らない）
  const ck2 = new f.w.MouseEvent('click', { bubbles: true, cancelable: true });
  f.doc.body.dispatchEvent(ck2);
  check(
    'UI 以外クリックは捕まえない（ChatGPT 側に見えている）',
    seen.docBubble === 1 && seen.winBubble === 1 && seen.winCap === 1
  );
  check('UI 外クリックで我々がスクロールを発射していない', calls.length === before + 1);
  f.dom.window.close();
}

// ======================================================================
// 18b) バー上のタッチは「実行中ジャンプのキャンセル」にならない +
//      touchstart を preventDefault して合成クリックを殺さない
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 900, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items[0].key;
  f.nav.jumpTo(key); // smooth ジャンプ開始
  check('ジャンプ中', f.nav.jumpState() !== null);

  const lateTouch = { n: 0 };
  f.w.addEventListener('touchstart', () => { lateTouch.n += 1; }, true); // 後乗りスパイ
  const ts = new f.w.Event('touchstart', { bubbles: true, cancelable: true });
  const row = f.doc.querySelector('.cnav-row');
  row.dispatchEvent(ts);
  check('バー上タッチで実行中ジャンプはキャンセルされない', f.nav.jumpState() !== null);
  check(
    'touchstart は未キャンセル（合成クリック温存）かつ後乗り側に見えない',
    ts.defaultPrevented === false && lateTouch.n === 0
  );
  void calls;
  f.dom.window.close();
}

// ======================================================================
// 19) 最下部拉致への再発射（保険）: ジャンプ直後に ChatGPT 側が
//     最下部へ引き戻しても、無操作なら1回だけ目標へ戻す
// ======================================================================
{
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan(); // cache-only 化

  f.nav.jumpTo(key);
  const approxCall = calls[calls.length - 1];
  check('approx 発射済み', approxCall.behavior === 'auto');
  const scroller = f.doc.getElementById('scroller');

  // ChatGPT 側の最下部吸着を模倣（我々の発射と無関係に scrollTop が最下部へ）
  scroller.scrollTop = 3200;
  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow + 200; // 発射から 60ms〜1200ms 窓 within
  f.nav.highlight();
  const re = calls[calls.length - 1];
  check(
    '最下部拉致を検知して目標へ再発射（auto・same target）',
    re !== approxCall && re.behavior === 'auto' && Math.abs(re.top - approxCall.top) <= 0.01,
    JSON.stringify(calls)
  );
  check('再発射後も approx のまま（再出現待ち継続）', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');

  // 再発射は1回限り（無限リトライ禁止）
  const callsAfterRe = calls.length;
  scroller.scrollTop = 3200;
  f.nav.highlight();
  check('2回目の拉致では再発射しない', calls.length === callsAfterRe);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ======================================================================
// 20) 合成意図ホイール: jumpTo はスクロール直前に __cnavIntent 付き
//     wheel を発射し、ChatGPT の最下部吸着に「利用者意図」を伝えてく
//     る。マーク付き wheel は自前の中断を発生させない
// ======================================================================
{
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const scroller = f.doc.getElementById('scroller');

  const wheels = [];
  scroller.addEventListener('wheel', (e) => wheels.push(e));

  f.nav.jumpTo(key); // inDOM smooth
  check('意図ホイールが発射された', wheels.length >= 1, JSON.stringify(wheels.map((e) => e.deltaY)));
  check('全ホイールに __cnavIntent マーク', wheels.every((e) => e.__cnavIntent === true));
  check(
    '目標が下＝実際の移動方向と一致する意図で deltaY>0・deltaMode=0',
    wheels.every((e) => e.deltaY > 0 && e.deltaMode === 0),
    JSON.stringify(wheels.map((e) => [e.deltaY, e.deltaMode]))
  );
  check(
    'scrollTo（smooth）は従来通り 1 発のみ',
    calls.length === 1 && calls[0].behavior === 'smooth',
    JSON.stringify(calls)
  );

  // マーク付き wheel はジャンプを中断しない
  const marked = new f.w.WheelEvent('wheel', { deltaY: 5, deltaMode: 0, bubbles: true });
  marked.__cnavIntent = true;
  f.w.dispatchEvent(marked);
  check('マーク付き wheel では中断しない', f.nav.jumpState() !== null);

  // 未マーク・untrusted の wheel（ChatGPT の再転送もどき）は中断しない
  const forward = new f.w.WheelEvent('wheel', { deltaY: 5, deltaMode: 0, bubbles: true });
  f.w.dispatchEvent(forward);
  check('未マーク・untrusted wheel では中断しない', f.nav.jumpState() !== null);

  // trusted ゲート OFF で実入力相当の wheel → 中断
  f.nav.internals.setTrustedOnlyCancel(false); // jsdom は isTrusted を偽造できない
  const plain = new f.w.WheelEvent('wheel', { deltaY: 5, deltaMode: 0, bubbles: true });
  f.w.dispatchEvent(plain);
  check('通常の wheel では中断する', f.nav.jumpState() === null);
  f.dom.window.close();
}

// ======================================================================
// 20c) 上方向ジャンプ → 意図ホイールも実際に一致した上方向（deltaY<0）
// ======================================================================
{
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 500, 60);
  f.nav.scan(); // scrollPosition 500 を記録
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  const scroller = f.doc.getElementById('scroller');
  scroller.scrollTop = 2500; // 下側を閲覧中の状態
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan(); // cache-only 化（位置 500 は保持）
  const wheels = [];
  scroller.addEventListener('wheel', (e) => wheels.push(e));
  const ok = f.nav.jumpTo(key);
  check('上方向ジャンプ試行（true）', ok === true);
  check(
    '目標が上なら意図も上（deltaY<0・deltaMode=0）',
    wheels.length >= 1 && wheels.every((e) => e.deltaY < 0 && e.deltaMode === 0),
    JSON.stringify(wheels.map((e) => [e.deltaY, e.deltaMode]))
  );
  check(
    'approx 目標 = 500-off へ auto',
    calls.length === 1 && calls[0].behavior === 'auto' && Math.abs(calls[0].top - (500 - off)) <= 0.01,
    JSON.stringify(calls)
  );
  f.dom.window.close();
}

// ======================================================================
// 20b) 意図ホイールの方向（目標＝最下部）と pump 窓: checkJump が
//      JUMP_INTENT_MS 間隔で追加発射し JUMP_INTENT_COVER_MS で止まる
// ======================================================================
{
  // 目標が最下部へクランプされるケース → 下方向意図
  const f = loadNav();
  mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 4000, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const scroller = f.doc.getElementById('scroller');
  const wheels = [];
  scroller.addEventListener('wheel', (e) => wheels.push(e));
  f.nav.jumpTo(key);
  check(
    '目標＝最下部なら下方向意図（deltaY>0）',
    wheels.length >= 1 && wheels.every((e) => e.deltaY > 0),
    JSON.stringify(wheels.map((e) => e.deltaY))
  );
  f.dom.window.close();
}
{
  // pump: 移動継続中に窓（700ms）を過ぎると意図発射が止まる。
  // スクロールは動かし続ける（＝real smooth らしい挙動）ので stall は発火しない
  const f = loadNav();
  mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60); // 目標 1500-off ≠ 最下部
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const scroller = f.doc.getElementById('scroller');
  const wheels = [];
  scroller.addEventListener('wheel', (e) => wheels.push(e));

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow; // 発射時刻を固定
  f.nav.jumpTo(key);
  scroller.scrollTop = 700; // smooth 実行中（目標未到）を模倣

  f.w.Date.now = () => realNow + 200; // 発射間隔 120ms 経過・窓内
  f.nav.highlight();
  const n2 = wheels.length;
  check('pump: 追加発射された', n2 >= 2, JSON.stringify(wheels.map((e) => e.deltaY)));
  check('pump 後もジャンプ継続中', f.nav.jumpState() !== null);

  scroller.scrollTop = 1100; // まだ動いている
  f.w.Date.now = () => realNow + 400; // 窓内（≤700）
  f.nav.highlight();
  const n4 = wheels.length;
  check('窓内なら pump 継続', n4 === n2 + 1, JSON.stringify(wheels.map((e) => e.deltaY)));

  scroller.scrollTop = 1250; // まだ動いている
  f.w.Date.now = () => realNow + 800; // 被曝窓 700ms 超過
  f.nav.highlight();
  check('被曝窓超過では追加発射しない', wheels.length === n4, JSON.stringify(wheels.map((e) => e.deltaY)));
  check('未着地でジャンプは継続中', f.nav.jumpState() !== null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ======================================================================
// 21) 初回ジャンプ丸飲み（Pin）の自動検知:
//     発射してもページが全く動かない場合、1回だけ再発射する
//     （利用者の「もう一回クリック」を自動でやる）
// ======================================================================
{
  // 21a) inDOM smooth が飲み込まれた → auto で1回だけ再発射
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  const scroller = f.doc.getElementById('scroller');
  const wheels = [];
  scroller.addEventListener('wheel', (e) => wheels.push(e));

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key); // smooth @ 1500-off（stubs 上は st=1385 相当へ動く）
  check('smooth 発射済み', calls.length === 1 && calls[0].behavior === 'smooth');
  check('jump に startScroll が記録されている', f.nav.jumpState() && f.nav.jumpState().startScroll === 0);

  // ChatGPT 側がスクロールを無効化（発射位置へ戻す＝Pin）したのを模倣
  scroller.scrollTop = 0;
  f.w.Date.now = () => realNow + 300; // stuck 窓（250ms）超過
  f.nav.highlight();
  const re = calls.length >= 2 ? calls[1] : null;
  check(
    'stuck 検知で auto 再発射（同じ目標へ）',
    re && re.behavior === 'auto' && Math.abs(re.top - (1500 - off)) <= 0.01,
    JSON.stringify(calls)
  );
  check('再発射で reasserted=true', f.nav.jumpState() && f.nav.jumpState().reasserted === true);
  check('再発射時にも意図ホイールが出ている', wheels.length >= 3, String(wheels.length));

  // もう一度 Pin されても再発射は打ち切り（1回限り・無限リトライ禁止）
  scroller.scrollTop = 0;
  f.w.Date.now = () => realNow + 600;
  f.nav.highlight();
  check('2度の Pin では再発射しない', calls.length === 2, JSON.stringify(calls));
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 21b) smooth が実際に動いている最中は stuck 誤検知しない
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key);
  scroller.scrollTop = 700; // smooth 実行中（途中経過）を模倣
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('移動中のため stuck 再発射なし', calls.length === 1, JSON.stringify(calls));
  check('ジャンプ継続中', f.nav.jumpState() !== null);

  // 着地
  scroller.scrollTop = 1500 - f.nav.internals.topOffset();
  f.w.Date.now = () => realNow + 400;
  f.nav.highlight();
  check('着地で jump 解除', f.nav.jumpState() === null);
  check('scrollTo は発射1発のみ', calls.length === 1, JSON.stringify(calls));
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 21c) approx（キャッシュのみ）の飲み込まれも再発射
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan(); // cache-only 化

  const scroller = f.doc.getElementById('scroller');
  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key); // approx auto
  check('approx 発射済み', calls.length === 1 && calls[0].behavior === 'auto');
  scroller.scrollTop = 0; // Pin 模倣
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check(
    'approx でも stuck 再発射（auto・same target）',
    calls.length === 2 && calls[1].behavior === 'auto' &&
      Math.abs(calls[1].top - calls[0].top) <= 0.01,
    JSON.stringify(calls)
  );
  void off;
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 21d) 絶対位置欠落時は relativePosition × scrollHeight で推定ジャンプ
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  const entry = f.nav.internals.itemsByKey.get(key);
  check('scan で relativePosition 記録', Number.isFinite(entry.relativePosition), String(entry.relativePosition));
  f.doc.querySelector('[data-turn-key="T1"]').remove();
  f.nav.scan();
  entry.scrollPosition = null; // 絶対位置を欠落させて相対のみにする
  check('cache-only 化', !f.nav.snapshot().items.find((i) => i.key === key).inDOM);
  const ok = f.nav.jumpTo(key);
  check('相対位置でジャンプ試行（true）', ok === true);
  check(
    'base = relative×4000 = 1500 と同じ目標へ auto',
    calls.length === 1 && calls[0].behavior === 'auto' && Math.abs(calls[0].top - (1500 - off)) <= 0.01,
    JSON.stringify(calls)
  );

  // 両方欠落なら false（推測で飛さない）
  entry.relativePosition = null;
  check('位置情報全欠落では jumpTo=false', f.nav.jumpTo(key) === false);
  f.dom.window.close();
}

// ======================================================================
// 22) デバッグリングログ: __chatgptNav.log() / clearLog()
// ======================================================================
{
  const f = loadNav();
  const calls = mount(f, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  f.nav.jumpTo(key);
  const log = f.nav.log();
  check('log() は文字列で nav init を含む', typeof log === 'string' && log.includes('nav init'), log.slice(0, 120));
  check('jump start がリングに記録', log.includes('jump start (inDOM smooth)'), '');
  check('scroller 記述がリングに入っている', /sc=div#scroller|sh=\d+ ch=\d+/.test(log), '');
  f.nav.clearLog();
  check('clearLog で空になる', f.nav.log() === '');
  void calls;
  f.dom.window.close();
}

// ======================================================================
// 23) smooth 途中フリーズ（仮想化 reflow で座標がずれる実機症状）:
//     220ms 無移動なら LIVE 実測へ 1 回だけ auto 補正する
// ======================================================================
{
  // 23a) 停滞→live 再計測で auto 補正→着地
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key); // target = 1500-off
  check('smooth 発射済み', calls.length === 1 && calls[0].behavior === 'smooth');

  // smooth が途中で死んだ（st=800）を模倣。stub の rect は viewport 相対なので
  // st とともに「実測 absTop」も変わる＝実機で起きた座標シフトと同型
  scroller.scrollTop = 800;
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('移動を観測した直後は補正しない', calls.length === 1, JSON.stringify(calls));

  f.w.Date.now = () => realNow + 600; // 停滞 300ms ≥ 220ms
  f.nav.highlight();
  const liveDesired = 800 + 1500 - off; // absTop = st + rect - sc(0) - off
  check(
    'stall-fix: LIVE 実測へ auto 1 発',
    calls.length === 2 && calls[1].behavior === 'auto' &&
      Math.abs(calls[1].top - liveDesired) <= 0.01,
    JSON.stringify(calls)
  );
  check('補正後は target が live 値に更新', f.nav.jumpState() && Math.abs(f.nav.jumpState().targetScroll - liveDesired) <= 0.01);
  check('stallFixed=true', f.nav.jumpState() && f.nav.jumpState().stallFixed === true);

  // 補正で着地 → 次 tick で完了
  f.w.Date.now = () => realNow + 700;
  f.nav.highlight();
  check('補正位置に着地で jump 解除', f.nav.jumpState() === null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 23b) stall 補正は JUMP_MAX_FIXES まで（予算枯渇で打ち切り・無限リトライ禁止）
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const off = f.nav.internals.topOffset();
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key); // c1 = smooth (1500-off)
  scroller.scrollTop = 800; // reflow 模拟で st を移動
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight(); // 移動観測
  f.w.Date.now = () => realNow + 600;
  f.nav.highlight(); // stall → fix#1 auto → st=2300-off
  check('fix#1 発射', calls.length === 2 && calls[1].behavior === 'auto'
    && Math.abs(calls[1].top - (2300 - off)) <= 0.01, JSON.stringify(calls));
  check('fixes=1', f.nav.jumpState() && f.nav.jumpState().fixes === 1
    && f.nav.jumpState().stallFixed === true);

  scroller.scrollTop = 700; // また別の reflow
  f.w.Date.now = () => realNow + 900;
  f.nav.highlight(); // 移動観測
  f.w.Date.now = () => realNow + 1200;
  f.nav.highlight(); // stall → fix#2 auto → st=2200-off
  check('fix#2 発射', calls.length === 3 && calls[2].behavior === 'auto'
    && Math.abs(calls[2].top - (2200 - off)) <= 0.01, JSON.stringify(calls));

  scroller.scrollTop = 600;
  f.w.Date.now = () => realNow + 1500;
  f.nav.highlight(); // 移動観測
  f.w.Date.now = () => realNow + 1800;
  f.nav.highlight(); // stall → fix#3 auto（予算最後の 1 発）
  check('fix#3 発射', calls.length === 4 && calls[3].behavior === 'auto'
    && Math.abs(calls[3].top - (2100 - off)) <= 0.01, JSON.stringify(calls));
  check('fixes=3（予算上限）', f.nav.jumpState() && f.nav.jumpState().fixes === 3);

  scroller.scrollTop = 500;
  f.w.Date.now = () => realNow + 2100;
  f.nav.highlight(); // 移動観測
  f.w.Date.now = () => realNow + 2400; // stall だが fixes 予算残りゼロ
  f.nav.highlight();
  check('予算枯渇でこれ以上補正しない', calls.length === 4, JSON.stringify(calls));
  check('予算枯渇で jump 打ち切り', f.nav.jumpState() === null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 23c) stall して LIVE 要素が見つからない場合、rel × maxScroll で 1 回だけ re-aimし
  //      approx に戻って再描画を待つ（re-aim は reaimed で 1 回限り）
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key);
  check('smooth 発射済み', calls.length === 1);
  // 応答が消えて stall した状態（unit を DOM から外す）
  unit.remove();
  scroller.scrollTop = 900;
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  f.w.Date.now = () => realNow + 600; // stall ≥ 220ms
  f.nav.highlight();
  // rel = 1500/4000 = 0.375 → reTarget = 0.375 × 3200 = 1200（|1200-900|≥60）
  check('rel re-aim を 1 発だけ発射', calls.length === 2 && calls[1].behavior === 'auto'
    && Math.abs(calls[1].top - 1200) <= 0.01, JSON.stringify(calls));
  check('phase は approx に戻り reaimed=true（rel は guesses として計上）',
    f.nav.jumpState() && f.nav.jumpState().phase === 'approx'
      && f.nav.jumpState().reaimed === true && f.nav.jumpState().fixes === 0
      && f.nav.jumpState().guesses === 1,
    JSON.stringify(f.nav.jumpState()));
  // さらに stall しても reaimed 済みなので発射しない
  f.w.Date.now = () => realNow + 900;
  f.nav.highlight();
  check('re-aim は 1 回限り', calls.length === 2, JSON.stringify(calls));
  f.w.Date.now = () => realNow + 4000; // deadline 超過
  f.nav.highlight();
  check('deadline で打ち切り', f.nav.jumpState() === null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 23d) stall + LIVE 要素なし + rel 欠落 → 新規スクロールせず打ち切り待ち（推測で飛さない）
  const f = loadNav();
  const calls = mountWith(f, 4000, 800, [{ turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] }]);
  const unit = f.doc.querySelector('[data-content-search-unit-key]');
  stubRect(unit, 1500, 60);
  f.nav.scan();
  const key = f.nav.snapshot().items.find((i) => i.turnKey === 'T1').key;
  const entry = f.nav.internals.itemsByKey.get(key);
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(key);
  check('smooth 発射済み', calls.length === 1);
  unit.remove();
  entry.relativePosition = null; // re-aim の材料も奪う
  scroller.scrollTop = 900;
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  f.w.Date.now = () => realNow + 600;
  f.nav.highlight();
  check('LIVE なし・rel なしならスクロールを発射しない', calls.length === 1, JSON.stringify(calls));
  check('ジャンプは生存したまま再描画待ち', f.nav.jumpState() !== null);
  f.w.Date.now = () => realNow + 2000;
  f.nav.highlight();
  check('deadline で打ち切り', f.nav.jumpState() === null);
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ======================================================================
// 24) v0.10.9: 会話順アンカー再推定（hill-climb re-aim）
//     cached abs/rel は崩壊フレームで無意味。会話順＋ターン高＋
//     レンダリング済みアンカーから再照準する
// ======================================================================
{
  // 24a) cache-only クリック：壊れた cached pos ではなく anchor base を使う
  const f = loadNav();
  const calls = mountWith(f, 20000, 800, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60);
  stubRect(unitOf('T2'), 2200, 60);
  stubRect(unitOf('T3'), 4000, 60);
  stubHeight(turnElOf('T1'), 1500);
  stubHeight(turnElOf('T2'), 1600);
  stubHeight(turnElOf('T3'), 1400);
  f.nav.scan();
  const k3 = f.nav.snapshot().items.find((i) => i.turnKey === 'T3').key;
  const off = f.nav.internals.topOffset();
  turnElOf('T3').remove();
  f.nav.scan();
  check('T3 は cache-only 化', !f.nav.snapshot().items.find((i) => i.turnKey === 'T3').inDOM);
  // 仮想化崩壊フレーム：レンダリング位置がずれ cached pos(4000) は無効化
  stubRect(turnElOf('T1'), 500);
  stubRect(turnElOf('T2'), 2500);
  const ok = f.nav.jumpTo(k3);
  check('anchor 推定だけで飛べる', ok === true);
  // anchor T2: abs=2500 + h1600 + gap12 = 4112 → target = 4112-off
  const expected = 2500 + 1600 + 12 - off;
  check(
    '目標は anchor 再推定（壊れた cached pos 4000 ではない）',
    calls.length === 1 && calls[0].behavior === 'auto' &&
      Math.abs(calls[0].top - expected) <= 0.01 && Math.abs(calls[0].top - (4000 - off)) > 1,
    JSON.stringify(calls)
  );
  check('scan で turnHeights がキャッシュされている',
    f.nav.internals.turnHeights.get('T2') === 1600,
    JSON.stringify([...f.nav.internals.turnHeights.entries()]));
  f.dom.window.close();
}
{
  // 24b) approx で再描画来ず：クールダウン中（500ms 未満）は抑止、
  //      +500ms 以降は reflow を追跡して auto re-aim（fixes と別枠 guesses）
  const f = loadNav();
  const calls = mountWith(f, 20000, 800, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60);
  stubRect(unitOf('T2'), 2200, 60);
  stubRect(unitOf('T3'), 4000, 60);
  stubHeight(turnElOf('T1'), 1500);
  stubHeight(turnElOf('T2'), 1600);
  stubHeight(turnElOf('T3'), 1400);
  f.nav.scan();
  const k3 = f.nav.snapshot().items.find((i) => i.turnKey === 'T3').key;
  const off = f.nav.internals.topOffset();
  turnElOf('T3').remove();
  f.nav.scan();
  stubRect(turnElOf('T1'), 500);
  stubRect(turnElOf('T2'), 2500);

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(k3); // c1 = anchor base 4112-off
  check('初発は anchor base', calls.length === 1 && Math.abs(calls[0].top - (4112 - off)) <= 0.01, JSON.stringify(calls));
  f.nav.highlight();
  check('クールダウン中（<500ms）は re-aim しない', calls.length === 1, JSON.stringify(calls));
  // load-more reflow 模擬：anchor が 1500 上昇
  const stNow = f.doc.getElementById('scroller').scrollTop;
  stubRect(turnElOf('T1'), -1000 - stNow);
  stubRect(turnElOf('T2'), 1000 - stNow);
  f.w.Date.now = () => realNow + 600;
  f.nav.highlight();
  const expected2 = 1000 + 1600 + 12 - off;
  check('600ms 後に re-aim 発射（reflow 追跡）',
    calls.length === 2 && calls[1].behavior === 'auto' &&
      Math.abs(calls[1].top - expected2) <= 0.01, JSON.stringify(calls));
  const js = f.nav.jumpState();
  check('guesses=1・fixes は消費しない・approx 継続',
    js && js.guesses === 1 && js.fixes === 0 && js.phase === 'approx', JSON.stringify(js));
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 24c) smooth 飛行中に目標消失：LIVE なし・anchor あり → 壊れた rel ではなく
  //      anchor 推定で発射（実機「下方向に飛べない」の再現タール）
  const f = loadNav();
  const calls = mountWith(f, 20000, 800, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60);
  stubRect(unitOf('T2'), 9000, 60);
  stubHeight(turnElOf('T1'), 1500);
  stubHeight(turnElOf('T2'), 1400);
  f.nav.scan();
  const k2 = f.nav.snapshot().items.find((i) => i.turnKey === 'T2').key;
  const off = f.nav.internals.topOffset();
  const scroller = f.doc.getElementById('scroller');

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(k2); // smooth target = 9000-off
  check('smooth 発射済み', calls.length === 1 && calls[0].behavior === 'smooth');
  // 飛行中にターゲットが消え、smooth は 8000 で停止
  unitOf('T2').remove();
  scroller.scrollTop = 8000;
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight(); // 移動観測フェーズ
  check('移動観測直後は re-aim しない', calls.length === 1, JSON.stringify(calls));
  // T1 anchor は今 abs=600 に居る
  stubRect(turnElOf('T1'), 600 - scroller.scrollTop);
  f.w.Date.now = () => realNow + 600; // stall ≥ 220ms
  f.nav.highlight();
  const expectTop = 600 + 1500 + 12 - off; // T1abs + T1h + gap - off
  check('anchor 再照準が発射（壊れた rel×max=8640 ではない）',
    calls.length === 2 && calls[1].behavior === 'auto' &&
      Math.abs(calls[1].top - expectTop) <= 0.01, JSON.stringify(calls));
  const js = f.nav.jumpState();
  check('guesses=1・reaimed は false のまま（anchor パス）',
    js && js.guesses === 1 && js.reaimed === false && js.phase === 'approx', JSON.stringify(js));
  check('ログに rendered-anchor が残る', f.nav.log().includes('rendered-anchor'), '');
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ======================================================================
// 25) ショートカットジャンプ: Alt+↑/↓ ＝ 1つ上/下の回答冒頭、Alt+K/J 別名
//     基準は jump 中なら jump.key／そうでなければ activeKey。
//     未知時は記録位置で近似。端で折り返さず、自分のジャンプを中断しない
// ======================================================================
function pressAlt(f, key, mods = {}) {
  f.w.dispatchEvent(new f.w.KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, mods)));
}
{
  // 25a) activeKey 起点の歩き・别名・キャンセル側除外
  const f = loadNav();
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  f.doc.getElementById('scroller').scrollTop = 1000;
  // abs = st(1000)+rel: T1=1050（基準線通過）/ T2=1650 / T3=2250
  stubRect(unitOf('T1'), 50);
  stubRect(unitOf('T2'), 650);
  stubRect(unitOf('T3'), 1250);
  f.nav.scan();
  const [k1, k2, k3] = snapItems(f.nav).map((i) => i.key);
  check('25a active は T1', f.nav.highlight() === k1, String(f.nav.highlight()));
  check('25a 出発前にジャンプ無し', f.nav.jumpState() === null);

  pressAlt(f, 'ArrowDown', { altKey: true });
  check('Alt+ArrowDown → 1つ下（T2）', f.nav.jumpState() && f.nav.jumpState().key === k2, JSON.stringify(f.nav.jumpState()));
  pressAlt(f, 'ArrowDown', { altKey: true });
  check('連打は jump.key 基準で連鎖（T3）', f.nav.jumpState() && f.nav.jumpState().key === k3, JSON.stringify(f.nav.jumpState()));
  pressAlt(f, 'ArrowUp', { altKey: true });
  check('Alt+ArrowUp → 1つ上（T2）', f.nav.jumpState() && f.nav.jumpState().key === k2, JSON.stringify(f.nav.jumpState()));
  pressAlt(f, 'j', { altKey: true });
  check('Alt+j 別名 = next（T3）', f.nav.jumpState() && f.nav.jumpState().key === k3, JSON.stringify(f.nav.jumpState()));
  pressAlt(f, 'K', { altKey: true });
  check('Alt+K 別名 = prev（T2）', f.nav.jumpState() && f.nav.jumpState().key === k2, JSON.stringify(f.nav.jumpState()));

  const stAlt = f.nav.jumpState();
  pressAlt(f, 'j'); // Alt 無しはショートカットでも中断キーでもない
  check('j 単体（Alt無し）はジャンプを変えない', f.nav.jumpState() && f.nav.jumpState().key === (stAlt && stAlt.key), JSON.stringify(f.nav.jumpState()));

  // ホールド時のオートリピートは丸ごと無視：ホップも増やさず、進行中ジャンプも消さない
  const stRepeatBase = f.nav.jumpState();
  pressAlt(f, 'ArrowDown', { altKey: true, repeat: true });
  pressAlt(f, 'ArrowDown', { altKey: true, repeat: true });
  check('オートリピート（押下長押し）は無視（先頭不変・中断せず）',
    f.nav.jumpState() && stRepeatBase && f.nav.jumpState().key === stRepeatBase.key,
    JSON.stringify(f.nav.jumpState()));

  // Alt コンボの keydown はページ側へ渡らない（stopImmediatePropagation）
  let pageSaw = 0;
  const probe = () => { pageSaw += 1; };
  f.w.addEventListener('keydown', probe, true);
  pressAlt(f, 'ArrowDown', { altKey: true });
  pressAlt(f, 'j', { altKey: true });
  check('Alt コンボはページ側ハンドラに届かない', pageSaw === 0, String(pageSaw));
  pressAlt(f, 'x');
  check('非ショートカットの keydown は従来通りページ側へ', pageSaw === 1, String(pageSaw));
  f.w.removeEventListener('keydown', probe, true);

  pressAlt(f, 'ArrowDown', { altKey: true, shiftKey: true });
  check('Shift+Alt+↓ はショートカットでなく中断側に回る', f.nav.jumpState() === null, JSON.stringify(f.nav.jumpState()));
  pressAlt(f, 'ArrowUp', { altKey: true, ctrlKey: true });
  check('Ctrl+Alt+↑ はショートカットでなく中断側に回る', f.nav.jumpState() === null);

  // 自分のジャンプを自分で中断しないこと（代替で生き続けていること自体が証明）。
  // 既存の素の矢印キーでの中断はそのまま。
  f.nav.jumpTo(k2);
  check('ジャンプ再開（T2）', f.nav.jumpState() && f.nav.jumpState().key === k2);
  pressAlt(f, 'ArrowUp', { ctrlKey: true });
  check('素の Ctrl+↑（ショートカット外）は中断する', f.nav.jumpState() === null);
  f.nav.jumpTo(k2);
  pressAlt(f, 'ArrowDown'); // 素の ArrowDown
  check('素の ↓ は従来通り中断', f.nav.jumpState() === null);
  f.dom.window.close();
}
{
  // 25b) 端では折り返し no-op
  const f = loadNav();
  mount(f, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  f.doc.getElementById('scroller').scrollTop = 1000;
  stubRect(unitOf('T1'), 50);
  stubRect(unitOf('T2'), 650);
  stubRect(unitOf('T3'), 1250);
  f.nav.scan();
  const [k1, , k3] = snapItems(f.nav).map((i) => i.key);
  check('25b active は T1（先頭）', f.nav.highlight() === k1);
  pressAlt(f, 'ArrowUp', { altKey: true });
  check('先頭で Alt+↑ は no-op', f.nav.jumpState() === null, JSON.stringify(f.nav.jumpState()));

  stubRect(unitOf('T1'), -2200);
  stubRect(unitOf('T2'), -1200);
  stubRect(unitOf('T3'), -50);
  check('25b active を T3（末尾）へ', f.nav.highlight() === k3);
  pressAlt(f, 'ArrowDown', { altKey: true });
  check('末尾で Alt+↓ は no-op', f.nav.jumpState() === null, JSON.stringify(f.nav.jumpState()));
  f.dom.window.close();
}
{
  // 25c) activeKey 不明時の記録位置近似（仮想化で消えたキャッシュへの prev）
  //  ※ updateActive には「2ビューポート以内のキャッシュ補完」があるため、
  //    active を本当に不明にするには記録位置を 2vp より遠くへ置く必要あり
  const f = loadNav();
  mountWith(f, 16000, 800, [
    { turnKey: 'T0', answers: [{ msg: 'M0', text: '回答零' }] },
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  f.doc.getElementById('scroller').scrollTop = 1000;
  // 全て基準線より下（rel>off）なので active は決まらない
  stubRect(unitOf('T0'), 200); // abs 1200
  stubRect(unitOf('T1'), 400); // abs 1400
  stubRect(unitOf('T2'), 600); // abs 1600
  f.nav.scan();
  check('25c active 不明', f.nav.highlight() === null, String(f.nav.highlight()));
  const [k0, k1, k2] = snapItems(f.nav).map((i) => i.key);
  void k0; void k2;

  // T0/T1 が仮想化で DOM から消える（記録位置は 1200/1400 のまま）
  // mountWith で作り直す（scroller は st=0 にリセットされる）ので大きい.scrollHeight を維持する
  mountWith(f, 16000, 800, [{ turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] }]);
  f.doc.getElementById('scroller').scrollTop = 5000;
  stubRect(unitOf('T2'), 300); // 画面内だが基準線より下（rel=300）、abs 5300
  f.nav.scan();
  check('25c 再スキャン後も active 不明（記録が 2vp 以上遠い）', f.nav.highlight() === null, String(f.nav.highlight()));

  pressAlt(f, 'ArrowUp', { altKey: true });
  check('active 不明でも prev ＝ 上端より上の最後の記録（T1）へ approx',
    f.nav.jumpState() && f.nav.jumpState().key === k1 && f.nav.jumpState().phase === 'approx',
    JSON.stringify(f.nav.jumpState()));

  // ジャンプを落としてから next の近似を確認（jump.key 基準にならない状態で）
  pressAlt(f, 'PageUp');
  check('PageUp で中断', f.nav.jumpState() === null);
  pressAlt(f, 'ArrowDown', { altKey: true });
  check('active 不明 next ＝ 下端より下の最初の記録（T2）へ',
    f.nav.jumpState() && f.nav.jumpState().key === k2, JSON.stringify(f.nav.jumpState()));
  f.dom.window.close();
}
{
  // 25d) 回答未ロードでは例外も出さず no-op
  const f = loadNav();
  pressAlt(f, 'ArrowDown', { altKey: true });
  pressAlt(f, 'k', { altKey: true });
  check('未ロードでは no-op（例外なし・ジャンプなし）', f.nav.jumpState() === null);
  f.dom.window.close();
}

// ======================================================================
// 26) v0.10.12: 下方向ジャンプ後の「最下部拉致（bottom-pull）」検知
//     ChatGPT の仮想化崩壊フレームで st が新 max に吸着すると、
//     クランプされた desired == st が成立して「 landed (no correction)」
//     誤判定 → 直後に最新回答へ引きずられる（実測の「どの位置からでも
//     最新へ」症状）。目標が最新（items 末尾）でなければ再照準する。
// ======================================================================
{
  // 26a) approx 着地チェックで st==新max かつ目標は末尾以外 → 再照準発射
  const f = loadNav();
  const calls = mountWith(f, 28500, 1322, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
    { turnKey: 'T4', answers: [{ msg: 'M4', text: '回答四' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60); stubRect(unitOf('T2'), 7600, 60);
  stubRect(unitOf('T3'), 14800, 60); stubRect(unitOf('T4'), 21000, 60);
  stubHeight(turnElOf('T1'), 6000); stubHeight(turnElOf('T2'), 7000);
  stubHeight(turnElOf('T3'), 6000); stubHeight(turnElOf('T4'), 6000);
  stubRect(turnElOf('T2'), 15000); // 発射時 anchor: abs=15000 → base=22012（新max超え）
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  const k3 = f.nav.snapshot().items.find((i) => i.turnKey === 'T3').key;
  const k4 = f.nav.snapshot().items.find((i) => i.turnKey === 'T4').key;
  void k4;

  // 実機同様に T3 は下方向 cache-only で発射
  const t3turn = turnElOf('T3');
  t3turn.remove();
  f.nav.scan();
  check('26a 目標 T3 は cache-only', !f.nav.snapshot().items.find((i) => i.turnKey === 'T3').inDOM);

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(k3);
  check('26a approx 発射済み', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');

  // 仮想化崩壊＋最下部拉致シミュレーション：
  //   sh 28500→17791、新 max=16469 に st 吸着、T3 再レンダリング済みで
  //   abs = max+off（= desired クランプ値が st と一致してしまう）
  const sc = f.doc.getElementById('scroller');
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 17791 });
  sc.scrollTop = 16469;
  const transcriptEl = f.doc.querySelector('[data-rail-chat-transcript="true"]');
  transcriptEl.appendChild(t3turn);
  stubRect(unitOf('T3'), off); // abs = st+off → 新フレームで desired は st==max と一致する
  // 再照準の材料：T2 anchor が live で abs=9000 → base=9000+7000+12=16012
  stubRect(turnElOf('T2'), 9000 - sc.scrollTop);
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('26a 誤着地せずジャンプ生存', f.nav.jumpState() !== null, JSON.stringify(f.nav.jumpState()));
  check('26a bottom-pull 検知ログ', f.nav.log().includes('bottom-pull'), '');
  check('26a ライトタグは approx-bottom-pull', f.nav.log().includes('approx-bottom-pull'), '');
  const reaim = calls[calls.length - 1];
  check('26a 再照準が anchor 推定 16012-off へ auto 発射',
    reaim && reaim.behavior === 'auto' && Math.abs(reaim.top - (16012 - off)) <= 0.01,
    JSON.stringify(calls));
  const js = f.nav.jumpState();
  check('26a guesses 予算を消費（fixes ではない）',
    js && js.guesses === 1 && js.fixes === 0, JSON.stringify(js));
  check('26a 「landed (no correction)」が出ていない',
    !f.nav.log().includes('landed (no correction)'), '');
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 26b) 目標が最新回答（items 末尾）なら max 着地は正しいので着地させる
  const f = loadNav();
  const calls = mountWith(f, 28500, 1322, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
    { turnKey: 'T4', answers: [{ msg: 'M4', text: '回答四' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60); stubRect(unitOf('T2'), 7600, 60);
  stubRect(unitOf('T3'), 14800, 60); stubRect(unitOf('T4'), 21000, 60);
  stubHeight(turnElOf('T1'), 6000); stubHeight(turnElOf('T2'), 7000);
  stubHeight(turnElOf('T3'), 6000); stubHeight(turnElOf('T4'), 6000);
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  const k4 = f.nav.snapshot().items.find((i) => i.turnKey === 'T4').key;

  const t4turn = turnElOf('T4');
  t4turn.remove();
  f.nav.scan();
  // 発射時に「新 max == 目標」になるような anchor を置いておく
  stubRect(turnElOf('T3'), 10457); // abs=10457 + h6000 + 12 = 16469 = 新max
  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(k4);
  check('26b 末尾へ approx 発射', f.nav.jumpState() && f.nav.jumpState().key === k4 &&
    f.nav.jumpState().phase === 'approx');
  const sc = f.doc.getElementById('scroller');
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 17791 });
  sc.scrollTop = 16469;
  const transcriptEl = f.doc.querySelector('[data-rail-chat-transcript="true"]');
  transcriptEl.appendChild(t4turn);
  stubRect(unitOf('T4'), off); // 末尾ターゲットが max+off の位置に再レンダされた状態
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('26b 末尾ターゲットは max でも着地扱い（ジャンプ終了）', f.nav.jumpState() === null,
    JSON.stringify(f.nav.jumpState()));
  check('26b bottom-pull 検知しない', !f.nav.log().includes('bottom-pull'), '');
  void calls;
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}
{
  // 26c) smooth 完了チェックでも同様に末尾以外が max 吸着なら再照準
  const f = loadNav();
  const calls = mountWith(f, 28500, 1322, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
    { turnKey: 'T4', answers: [{ msg: 'M4', text: '回答四' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60); stubRect(unitOf('T2'), 7600, 60);
  stubRect(unitOf('T3'), 14800, 60); stubRect(unitOf('T4'), 21000, 60);
  stubHeight(turnElOf('T1'), 6000); stubHeight(turnElOf('T2'), 7000);
  stubHeight(turnElOf('T3'), 6000); stubHeight(turnElOf('T4'), 6000);
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  const k3 = f.nav.snapshot().items.find((i) => i.turnKey === 'T3').key;

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  // 発射前に崩壊フレーム：T3 の live 位置が max+off でクランプされる並び
  const sc = f.doc.getElementById('scroller');
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 17791 });
  sc.scrollTop = 12000;
  stubRect(unitOf('T3'), 16469 + off - sc.scrollTop); // abs = max+off → target=max
  f.nav.jumpTo(k3);
  check('26c smooth 発射で target が max にクランプ',
    f.nav.jumpState() && f.nav.jumpState().phase === 'smooth' &&
      Math.abs(f.nav.jumpState().targetScroll - 16469) <= 0.01,
    JSON.stringify(f.nav.jumpState()));
  // st が max 吸着（飛行完了扱い）で pump
  sc.scrollTop = 16469;
  // 再照準材料：T2 anchor abs=9000
  stubRect(turnElOf('T2'), 9000 - sc.scrollTop);
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('26c smooth 側も誤完了せず再照準', f.nav.jumpState() !== null &&
    f.nav.log().includes('smooth-bottom-pull'), JSON.stringify(f.nav.jumpState()));
  const reaim = calls[calls.length - 1];
  check('26c 再照準 auto 発射（16012-off）',
    reaim && reaim.behavior === 'auto' && Math.abs(reaim.top - (16012 - off)) <= 0.01,
    JSON.stringify(calls));
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

{
  // 26d) 実機ケース：崩壊フレームでアンカー推定まで新 max と一致して
  //      LIVE 再照準が「already close」で空振り → 保留して jumpTo を
  //      まるごと再発射（v0.10.13）。予約は 1 度だけ二重発火しない。
  const f = loadNav();
  const calls = mountWith(f, 28500, 1322, [
    { turnKey: 'T1', answers: [{ msg: 'M1', text: '回答一' }] },
    { turnKey: 'T2', answers: [{ msg: 'M2', text: '回答二' }] },
    { turnKey: 'T3', answers: [{ msg: 'M3', text: '回答三' }] },
    { turnKey: 'T4', answers: [{ msg: 'M4', text: '回答四' }] },
  ]);
  const unitOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"] [data-content-search-unit-key]`);
  const turnElOf = (tk) => f.doc.querySelector(`[data-turn-key="${tk}"]`).closest('[data-virtualized-turn]');
  stubRect(unitOf('T1'), 400, 60); stubRect(unitOf('T2'), 7600, 60);
  stubRect(unitOf('T3'), 14800, 60); stubRect(unitOf('T4'), 21000, 60);
  stubHeight(turnElOf('T1'), 6000); stubHeight(turnElOf('T2'), 7000);
  stubHeight(turnElOf('T3'), 6000); stubHeight(turnElOf('T4'), 6000);
  stubRect(turnElOf('T2'), 15000); // 発射時 anchor: abs=15000 → base=22012（新max超え）
  f.nav.scan();
  const off = f.nav.internals.topOffset();
  const k3 = f.nav.snapshot().items.find((i) => i.turnKey === 'T3').key;
  const t3turn = turnElOf('T3');
  t3turn.remove();
  f.nav.scan();

  const realNow = f.w.Date.now();
  f.w.Date.now = () => realNow;
  f.nav.jumpTo(k3); // approx 発射
  check('26d approx 発射済み', f.nav.jumpState() && f.nav.jumpState().phase === 'approx');

  // 崩壊フレーム：st==max、T3 再レンダリ、T2 anchor abs=9600 →
  // base=9600+7000+12=16612 → est=clampTop(16612-off)=16469==st で re-aim 空振り
  const sc = f.doc.getElementById('scroller');
  Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 17791 });
  sc.scrollTop = 16469;
  const transcriptEl = f.doc.querySelector('[data-rail-chat-transcript="true"]');
  transcriptEl.appendChild(t3turn);
  stubRect(unitOf('T3'), off); // desired = st
  stubRect(turnElOf('T2'), 9600 - 16469); // abs = 9600
  f.w.Date.now = () => realNow + 300;
  f.nav.highlight();
  check('26d 誤着地せず・再発射予約 #1', f.nav.jumpState() !== null &&
    f.nav.jumpState().pullRetries === 1 && f.nav.log().includes('再発射予約 #1'),
    JSON.stringify(f.nav.jumpState()));
  check('26d re-aim は空振り（guesses 消費なし）',
    f.nav.jumpState() && f.nav.jumpState().guesses === 0, JSON.stringify(f.nav.jumpState()));
  // 保留中に pump しても予約は二重発火しない
  f.w.Date.now = () => realNow + 400;
  f.nav.highlight();
  check('26d 保留中は予約が増えない', f.nav.jumpState() !== null &&
    f.nav.jumpState().pullRetries === 1 &&
    (f.nav.log().match(/再発射予約/g) || []).length === 1, '');

  // 保留 → 実タイマーで #1 再発射。jsdom ではフレームが復元しないため
  // 再発射後も pull が続き、#2 予約 → 予算切れで「明示的 give up」する。
  // 黙って max に「landed/finished」しないことが重要。
  await sleep(1000);
  const dlog = f.nav.log();
  check('26d #1 再発射実行（jumpTo 再実行）', dlog.includes('再発射 #1'), '');
  check('26d frozen frame: #2 予約まで進む', dlog.includes('再発射予約 #2'), '');
  check('26d 予算切れで give up ログ（silent finish なし）',
    dlog.includes('give up at bottom-pull') &&
      !dlog.includes('jump landed (no correction)') &&
      !dlog.includes('jump finished'), '');
  check('26d 打ち切り後 jump 無し', f.nav.jumpState() === null,
    JSON.stringify(f.nav.jumpState()));
  f.w.Date.now = () => realNow;
  f.dom.window.close();
}

// ---- 結果 ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.pass && r.detail) console.log(`      ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} 件成功`);

process.exit(failed === 0 ? 0 : 1);
