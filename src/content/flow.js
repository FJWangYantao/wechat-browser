/*
 * 瀑布流阅读（隔离环境 content script）：
 *   - 连续阅读：章末继续往下滑（滚轮 / ↓ / PageDown / 空格），自动进入下一章
 *   - 自动滚屏：匀速向下滚动，读到章末停顿片刻后自动翻到下一章
 *
 * 微信读书一次只渲染一章，所以“跨章”靠点击页面上的「下一章」按钮实现。
 * 双栏（左右翻页）模式下页面不能上下滚动，这里的功能不会生效。
 */
(() => {
  'use strict';
  const { saveSettings } = globalThis.WRS;

  const NEXT_TEXT = /^\s*下一章\s*$/;
  const PULL_THRESHOLD = 360; // 章末继续下滑多少像素触发翻章
  const PULL_RESET_MS = 800; // 停止下滑多久后清零
  const ADVANCE_COOLDOWN_MS = 2500;
  const MIN_SPEED = 10;
  const MAX_SPEED = 400;

  const cfg = { enabled: false, flowMode: true, scrollSpeed: 60 };
  let pull = 0;
  let pullTimer = 0;
  let lastAdvance = 0;

  const scroller = () => document.scrollingElement || document.documentElement;

  function isScrollable() {
    return scroller().scrollHeight > window.innerHeight * 1.2;
  }

  function atBottom() {
    const el = scroller();
    return el.scrollTop + window.innerHeight >= el.scrollHeight - 4;
  }

  // 按文字找「下一章」，比依赖类名更抗改版。先找按钮/链接，再找叶子节点（点击会冒泡到外层的处理函数）。
  function findNextChapterButton() {
    const matches = (el) => NEXT_TEXT.test(el.textContent);
    const visible = (el) => el.getClientRects().length > 0;
    for (const root of [document.querySelector('.readerFooter'), document.body]) {
      if (!root) continue;
      const buttons = [...root.querySelectorAll('button, a, [role="button"]')].filter(matches);
      const leaves = [...root.querySelectorAll('div, span, p')].filter((el) => el.childElementCount === 0 && matches(el));
      const all = [...buttons, ...leaves];
      if (all.length) return all.find(visible) || all[0];
    }
    return null;
  }

  function goNextChapter() {
    const now = Date.now();
    if (now - lastAdvance < ADVANCE_COOLDOWN_MS) return false;
    const btn = findNextChapterButton();
    if (!btn) {
      ui.toast('已经是最后一章');
      stopAutoScroll();
      return false;
    }
    lastAdvance = now;
    pull = 0;
    ui.setPull(0);
    btn.click();
    ui.toast('下一章');
    return true;
  }

  // ---- 连续阅读：章末继续下滑 ----

  function addPull(delta) {
    if (!cfg.enabled || !cfg.flowMode || !isScrollable() || !atBottom()) return;
    pull += delta;
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      pull = 0;
      ui.setPull(0);
    }, PULL_RESET_MS);
    if (pull >= PULL_THRESHOLD) goNextChapter();
    else ui.setPull(pull / PULL_THRESHOLD);
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY > 0) addPull(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
    },
    { passive: true },
  );

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowDown') addPull(PULL_THRESHOLD / 3);
    else if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) addPull(PULL_THRESHOLD / 2);
  });

  // ---- 自动滚屏 ----

  const auto = { running: false, raf: 0, last: 0, carry: 0, bottomSince: 0 };

  function tick(t) {
    if (!auto.running) return;
    const dt = auto.last ? Math.min(t - auto.last, 100) : 0;
    auto.last = t;

    if (!isScrollable()) {
      // 新章节还没渲染出来时也会短暂不可滚动，等一等
      auto.raf = requestAnimationFrame(tick);
      return;
    }

    if (atBottom()) {
      // 停在章末，留出读完最后一屏的时间再翻章
      auto.bottomSince = auto.bottomSince || t;
      const wait = Math.max(1500, ((window.innerHeight * 0.6) / cfg.scrollSpeed) * 1000);
      if (cfg.flowMode && t - auto.bottomSince >= wait && goNextChapter()) auto.bottomSince = 0;
    } else {
      auto.bottomSince = 0;
      auto.carry += (cfg.scrollSpeed * dt) / 1000;
      const step = Math.floor(auto.carry);
      if (step > 0) {
        auto.carry -= step;
        window.scrollBy(0, step);
      }
    }
    auto.raf = requestAnimationFrame(tick);
  }

  function startAutoScroll() {
    if (!cfg.enabled) return;
    if (!isScrollable()) ui.toast('当前页面不能上下滚动，请在微信读书里切换到单栏模式');
    auto.running = true;
    auto.last = 0;
    auto.carry = 0;
    auto.bottomSince = 0;
    cancelAnimationFrame(auto.raf);
    auto.raf = requestAnimationFrame(tick);
    ui.showBar();
  }

  function pauseAutoScroll() {
    auto.running = false;
    cancelAnimationFrame(auto.raf);
    ui.renderBar();
  }

  function stopAutoScroll() {
    pauseAutoScroll();
    ui.hideBar();
  }

  function toggleAutoScroll() {
    if (auto.running) pauseAutoScroll();
    else startAutoScroll();
    return auto.running;
  }

  function changeSpeed(delta) {
    cfg.scrollSpeed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, cfg.scrollSpeed + delta));
    ui.renderBar();
    saveSettings({ scrollSpeed: cfg.scrollSpeed });
  }

  // ---- 页面上的浮动控件（Shadow DOM，不受页面样式影响） ----

  const ui = (() => {
    let host = null;
    let root = null;
    let toastTimer = 0;

    function mount() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'wrs-flow';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
<style>
  :host { all: initial; }
  .bar, .toast, .pull {
    position: fixed; z-index: 2147483647;
    font: 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #fff; background: rgba(30, 32, 36, .82);
    backdrop-filter: blur(6px); border-radius: 999px;
  }
  .bar { right: 24px; bottom: 24px; display: none; align-items: center; gap: 2px; padding: 4px; }
  .bar.show { display: flex; }
  .bar button {
    all: unset; min-width: 28px; height: 28px; padding: 0 6px; border-radius: 999px;
    text-align: center; cursor: pointer; box-sizing: border-box;
  }
  .bar button:hover { background: rgba(255, 255, 255, .16); }
  .speed { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; opacity: .85; }
  .toast {
    left: 50%; bottom: 72px; transform: translateX(-50%); padding: 8px 14px;
    opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  .toast.show { opacity: 1; }
  .pull {
    left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 14px;
    opacity: 0; transition: opacity .15s; pointer-events: none; overflow: hidden;
  }
  .pull.show { opacity: 1; }
  .pull i {
    position: absolute; left: 0; top: 0; bottom: 0; background: rgba(27, 136, 238, .55);
    width: 0; transition: width .1s;
  }
  .pull span { position: relative; }
</style>
<div class="bar" part="bar">
  <button class="play" title="暂停 / 继续"></button>
  <button class="slower" title="减速">−</button>
  <span class="speed"></span>
  <button class="faster" title="加速">+</button>
  <button class="close" title="关闭自动滚屏">×</button>
</div>
<div class="pull"><i></i><span>继续下滑进入下一章</span></div>
<div class="toast"></div>`;
      root.querySelector('.play').addEventListener('click', toggleAutoScroll);
      root.querySelector('.slower').addEventListener('click', () => changeSpeed(-10));
      root.querySelector('.faster').addEventListener('click', () => changeSpeed(10));
      root.querySelector('.close').addEventListener('click', stopAutoScroll);
      (document.body || document.documentElement).appendChild(host);
    }

    return {
      renderBar() {
        if (!root) return;
        root.querySelector('.play').textContent = auto.running ? '❚❚' : '▶';
        root.querySelector('.speed').textContent = `${cfg.scrollSpeed} px/s`;
      },
      showBar() {
        mount();
        root.querySelector('.bar').classList.add('show');
        this.renderBar();
      },
      hideBar() {
        root?.querySelector('.bar').classList.remove('show');
      },
      setPull(ratio) {
        if (!ratio && !root) return;
        mount();
        root.querySelector('.pull').classList.toggle('show', ratio > 0);
        root.querySelector('.pull i').style.width = `${Math.min(1, ratio) * 100}%`;
      },
      toast(text) {
        mount();
        const el = root.querySelector('.toast');
        el.textContent = text;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
      },
    };
  })();

  // ---- 与 popup / 快捷键通信 ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'wrs:toggleAutoScroll') sendResponse({ running: toggleAutoScroll() });
    else if (msg?.type === 'wrs:getAutoScroll') sendResponse({ running: auto.running });
  });

  globalThis.WRSFlow = {
    update(s) {
      cfg.enabled = s.enabled;
      cfg.flowMode = s.flowMode;
      cfg.scrollSpeed = s.scrollSpeed;
      if (!s.enabled) stopAutoScroll();
      ui.renderBar();
    },
  };
})();
