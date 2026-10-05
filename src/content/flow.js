/*
 * 连续滚动阅读（隔离环境 content script）——像刷知乎一样一直往下滚：
 *   - 无缝接章：快滚到章末时，把当前章节末尾的画面复制成静态块留在上方，
 *     再加载下一章并对齐滚动位置。画面不跳，继续往下滚就是下一章。
 *   - 自动滚屏：匀速向下滚动，同样无缝跨章。
 *   - 双栏（左右翻页）模式：滚轮 / 触控板滑动直接翻页，到章末自动进下一章，不用点按钮。
 *
 * 微信读书一次只渲染一章，加载下一章靠点击页面上的「下一章」按钮。
 */
(() => {
  'use strict';
  const { saveSettings } = globalThis.WRS;

  const NEXT_CHAPTER_TEXT = /^\s*下一章\s*$/;
  const NEXT_PAGE_TEXT = /^\s*下一页\s*$/;
  const PREV_PAGE_TEXT = /^\s*上一页\s*$/;
  const HISTORY_ID = 'wrs-history';
  const CHAPTER_GAP = 96; // 上一章末尾与下一章之间的留白
  const ADVANCE_COOLDOWN_MS = 2500;
  const MIN_SPEED = 10;
  const MAX_SPEED = 400;

  const cfg = { enabled: false, flowMode: true, scrollSpeed: 60 };
  let lastAdvance = 0;
  let lastY = 0;
  let hold = null; // 加载下一章期间锁定滚动位置
  let history = null; // 上一章末尾的静态快照
  let pagedHinted = false;
  let endHintedAt = 0;

  const scroller = () => document.scrollingElement || document.documentElement;

  function isScrollable() {
    return scroller().scrollHeight > window.innerHeight * 1.2;
  }

  function remaining() {
    const el = scroller();
    return el.scrollHeight - (el.scrollTop + window.innerHeight);
  }

  function nearEnd() {
    return remaining() <= Math.max(120, window.innerHeight * 0.25);
  }

  // 按文字找按钮，比依赖类名更抗改版。先找按钮/链接，再找叶子节点（点击会冒泡到外层的处理函数）。
  function findByText(re, roots) {
    const matches = (el) => re.test(el.textContent);
    const visible = (el) => el.getClientRects().length > 0;
    for (const root of roots) {
      if (!root) continue;
      const buttons = [...root.querySelectorAll('button, a, [role="button"]')].filter(matches);
      const leaves = [...root.querySelectorAll('div, span, p')].filter((el) => el.childElementCount === 0 && matches(el));
      const all = [...buttons, ...leaves];
      if (all.length) return all.find(visible) || all[0];
    }
    return null;
  }

  const findNextChapterButton = () => findByText(NEXT_CHAPTER_TEXT, [document.querySelector('.readerFooter'), document.body]);

  // 双栏翻页模式：页面不能滚动，且有「上一页 / 下一页」按钮。滚轮事件很密，结果缓存一小会儿
  let pagedCache = { at: 0, value: false };
  function isPaged() {
    if (isScrollable()) return false;
    const now = performance.now();
    if (now - pagedCache.at < 300) return pagedCache.value;
    const btn = findByText(NEXT_PAGE_TEXT, [document.body]) || findByText(PREV_PAGE_TEXT, [document.body]);
    pagedCache = { at: now, value: !!btn && btn.getClientRects().length > 0 };
    return pagedCache.value;
  }

  // 鼠标所在位置是否在一个自己会滚动的区域里（目录、笔记侧栏，或用内层容器滚动的正文）
  function innerScroller(target) {
    for (let el = target instanceof Element ? target : null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2) return el;
    }
    return null;
  }

  // 当前屏幕上的正文（由 page-hook.js 从画布记录中还原），用来判断页面有没有翻过去
  function visibleSignature() {
    let text = '';
    const onResponse = (e) => {
      try {
        text = JSON.parse(e.detail).text || '';
      } catch (_) {
        /* ignore */
      }
    };
    document.addEventListener('wrs:response', onResponse, { once: true });
    document.dispatchEvent(new CustomEvent('wrs:request', { detail: JSON.stringify({ type: 'visibleText' }) }));
    document.removeEventListener('wrs:response', onResponse);
    return text.slice(0, 300);
  }

  function hintPaged() {
    if (pagedHinted) return;
    pagedHinted = true;
    ui.toast('连续滚动需要单栏模式：点右侧「单双栏切换」按钮', 3500);
  }

  function endOfBook() {
    stopAutoScroll();
    if (Date.now() - endHintedAt > 5000) {
      endHintedAt = Date.now();
      ui.toast('已经是最后一章');
    }
  }

  // ---- 无缝接章 ----

  function readerCanvases() {
    return [...document.querySelectorAll('canvas')].filter((c) => {
      if (c.closest(`#${HISTORY_ID}`)) return false;
      const r = c.getBoundingClientRect();
      return c.width > 0 && c.height > 0 && r.width >= 200 && r.height >= 20;
    });
  }

  function commonAncestor(nodes) {
    let a = nodes[0].parentElement;
    while (a && !nodes.every((n) => a.contains(n))) a = a.parentElement;
    return a;
  }

  // 改动 DOM 后让 el 保持在屏幕上原来的位置（浏览器的滚动锚定做没做都适用）
  function keepInPlace(el, mutate) {
    const before = el ? el.getBoundingClientRect().top : 0;
    mutate();
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - before);
  }

  // 把“视口上方一屏 ~ 章末”这段画布的像素复制下来
  function buildHistory(canvases) {
    const sy = window.scrollY;
    const keepFrom = sy - window.innerHeight;
    const items = canvases
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter(({ r }) => r.bottom + sy > keepFrom);
    if (!items.length) return null;

    const top = Math.min(sy, Math.max(keepFrom, Math.min(...items.map(({ r }) => r.top + sy))));
    const bottom = Math.max(...items.map(({ r }) => r.bottom + sy));

    const el = document.createElement('div');
    el.id = HISTORY_ID;
    el.style.cssText = `position:relative;height:${bottom - top + CHAPTER_GAP}px;overflow:hidden;pointer-events:none;overflow-anchor:none;`;

    for (const { c, r } of items) {
      const docTop = r.top + sy;
      const cut = Math.max(0, top - docTop); // 画布顶部被裁掉的 CSS 像素
      const cssHeight = r.height - cut;
      const scaleY = c.height / r.height;
      const copy = document.createElement('canvas');
      copy.width = c.width;
      copy.height = Math.max(1, Math.round(cssHeight * scaleY));
      copy.getContext('2d').drawImage(c, 0, cut * scaleY, c.width, copy.height, 0, 0, c.width, copy.height);
      copy.style.cssText = `position:absolute;top:${docTop + cut - top}px;width:${r.width}px;height:${cssHeight}px;`;
      copy.dataset.left = String(r.left);
      el.appendChild(copy);
    }
    return { el, viewOffset: sy - top };
  }

  // 插在正文容器前面；校验正文确实被往下推了，否则换外层再试
  function insertHistory(h, canvases) {
    const probe = canvases[0];
    const docTop = () => probe.getBoundingClientRect().top + window.scrollY;
    const before = docTop();
    let anchor = commonAncestor(canvases);
    for (let i = 0; anchor && anchor !== document.body && i < 6; i++, anchor = anchor.parentElement) {
      anchor.parentNode.insertBefore(h.el, anchor);
      if (Math.abs(docTop() - before - h.el.offsetHeight) < 2) {
        // 相对快照块的中线定位：AI 面板开合导致正文重新居中时，快照跟着一起移动
        const rect = h.el.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        for (const copy of h.el.children) copy.style.left = `calc(50% + ${Number(copy.dataset.left) - center}px)`;
        return true;
      }
      h.el.remove();
    }
    return false;
  }

  function dropHistory() {
    if (!history) return;
    const el = history;
    history = null;
    keepInPlace(el.nextElementSibling, () => el.remove());
  }

  // 下一章加载期间，阅读器可能会把页面滚回顶部，这里把位置钉住，直到内容稳定或用户自己动了
  function holdScroll(y) {
    const start = performance.now();
    let lastFix = start;
    const fix = () => {
      if (Math.abs(window.scrollY - y) > 1) {
        window.scrollTo(0, y);
        lastFix = performance.now();
      }
    };
    const release = () => {
      hold = null;
      window.removeEventListener('scroll', fix);
      for (const type of ['wheel', 'keydown', 'touchstart', 'mousedown']) window.removeEventListener(type, release, true);
      lastY = window.scrollY;
    };
    const check = () => {
      if (!hold) return;
      const now = performance.now();
      if (now - start > 6000 || (now - start > 1200 && now - lastFix > 800)) return release();
      fix();
      requestAnimationFrame(check);
    };
    window.addEventListener('scroll', fix, { passive: true });
    for (const type of ['wheel', 'keydown', 'touchstart', 'mousedown']) window.addEventListener(type, release, true);
    hold = { release };
    requestAnimationFrame(check);
  }

  function continueToNextChapter() {
    if (hold || Date.now() - lastAdvance < ADVANCE_COOLDOWN_MS) return;
    const btn = findNextChapterButton();
    if (!btn) return endOfBook();
    lastAdvance = Date.now();

    dropHistory();
    const canvases = readerCanvases();
    const h = canvases.length ? buildHistory(canvases) : null;
    if (h && insertHistory(h, canvases)) {
      history = h.el;
      const y = h.el.getBoundingClientRect().top + window.scrollY + h.viewOffset;
      window.scrollTo(0, y);
      btn.click();
      holdScroll(y);
    } else {
      // 拿不到画布（DOM 渲染的旧版正文等）时退化为直接翻到下一章
      btn.click();
      ui.toast('下一章');
    }
  }

  // ---- 触发 ----

  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      const down = y > lastY;
      lastY = y;
      if (!cfg.enabled || !cfg.flowMode || hold) return;
      // 上一章的快照滚出视口一屏以上就移除，让页面恢复成阅读器原本的结构
      if (history && history.getBoundingClientRect().bottom < -window.innerHeight) dropHistory();
      if (down && isScrollable() && nearEnd()) continueToNextChapter();
    },
    { passive: true },
  );

  // 已经在底部（或章节太短不能滚动）时继续往下，scroll 事件不会触发，靠滚轮 / 按键兜底
  function pushDown() {
    if (!cfg.enabled || !cfg.flowMode || hold || isPaged()) return;
    if (!isScrollable() || nearEnd()) continueToNextChapter();
  }

  // ---- 双栏模式：滚轮 / 触控板滑动翻页 ----

  // 一次滑动（含触控板的惯性余波）只翻一页
  const paging = { sum: 0, lockUntil: 0, idle: 0, native: null };
  const SWIPE_THRESHOLD = 50;

  function flipPage(dir) {
    const btn = dir > 0 ? findByText(NEXT_PAGE_TEXT, [document.body]) || findNextChapterButton() : findByText(PREV_PAGE_TEXT, [document.body]);
    if (btn) {
      btn.click();
      pagedCache.at = 0;
    } else if (dir > 0 && !findByText(NEXT_PAGE_TEXT, [document.body])) {
      endOfBook();
    }
  }

  function pageByWheel(e) {
    const now = performance.now();
    if (now < paging.lockUntil) {
      paging.lockUntil = now + 250; // 惯性余波还在，继续锁住
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    clearTimeout(paging.idle);
    paging.idle = setTimeout(() => (paging.sum = 0), 250);
    paging.sum += d;
    if (Math.abs(paging.sum) < SWIPE_THRESHOLD) return;

    const dir = paging.sum > 0 ? 1 : -1;
    paging.sum = 0;
    paging.lockUntil = now + 450;
    if (paging.native === true) return;
    if (paging.native === false) return flipPage(dir);

    // 第一次：先看阅读器自己会不会响应滚轮翻页，会的话插件就不插手，免得一次翻两页
    const before = visibleSignature();
    setTimeout(() => {
      paging.native = before !== '' && visibleSignature() !== before;
      if (!paging.native) flipPage(dir);
    }, 400);
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (!cfg.enabled || !cfg.flowMode) return;
      const inner = innerScroller(e.target);
      if (inner && !inner.querySelector('canvas')) return; // 目录、笔记等侧栏自己的滚动，不管
      if (isPaged()) return pageByWheel(e);
      if (e.deltaY <= 0) return;
      if (inner) {
        // 正文在内层容器里滚动：滚到底再往下就直接翻到下一章
        if (inner.scrollTop + inner.clientHeight >= inner.scrollHeight - 4 && Date.now() - lastAdvance > ADVANCE_COOLDOWN_MS) {
          const btn = findNextChapterButton();
          if (btn) {
            lastAdvance = Date.now();
            btn.click();
          }
        }
        return;
      }
      pushDown();
    },
    { passive: true },
  );

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) pushDown();
  });

  // ---- 自动滚屏 ----

  const auto = { running: false, raf: 0, last: 0, carry: 0, stuckSince: 0 };

  function tick(t) {
    if (!auto.running) return;
    const dt = auto.last ? Math.min(t - auto.last, 100) : 0;
    auto.last = t;

    if (hold) {
      // 等下一章加载
    } else if (!isScrollable() || remaining() <= 1) {
      // 章节很短或已到底：留出读完这一屏的时间再接下一章
      auto.stuckSince = auto.stuckSince || t;
      const wait = Math.max(1500, ((window.innerHeight * 0.6) / cfg.scrollSpeed) * 1000);
      if (t - auto.stuckSince >= wait) {
        auto.stuckSince = 0;
        if (isPaged()) {
          hintPaged();
          return pauseAutoScroll();
        }
        if (!cfg.flowMode) {
          ui.toast('本章已读完');
          return pauseAutoScroll();
        }
        continueToNextChapter();
      }
    } else {
      auto.stuckSince = 0;
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
    if (isPaged()) {
      pagedHinted = false;
      hintPaged();
    }
    auto.running = true;
    auto.last = 0;
    auto.carry = 0;
    auto.stuckSince = 0;
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
  .bar, .toast {
    position: fixed; z-index: 2147483647;
    font: 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #fff; background: rgba(30, 32, 36, .82);
    backdrop-filter: blur(6px); border-radius: 999px;
  }
  .bar {
    right: calc(24px + var(--wrs-ai-w, 0px)); bottom: 24px; display: none; align-items: center; gap: 2px; padding: 4px;
    transition: right .22s ease;
  }
  .bar.show { display: flex; }
  .bar button {
    all: unset; min-width: 28px; height: 28px; padding: 0 6px; border-radius: 999px;
    text-align: center; cursor: pointer; box-sizing: border-box;
  }
  .bar button:hover { background: rgba(255, 255, 255, .16); }
  .speed { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; opacity: .85; }
  .toast {
    left: calc(50% - var(--wrs-ai-w, 0px) / 2); bottom: 72px; transform: translateX(-50%); padding: 8px 14px;
    opacity: 0; transition: opacity .2s; pointer-events: none; white-space: nowrap;
  }
  .toast.show { opacity: 1; }
</style>
<div class="bar">
  <button class="play" title="暂停 / 继续"></button>
  <button class="slower" title="减速">−</button>
  <span class="speed"></span>
  <button class="faster" title="加速">+</button>
  <button class="close" title="关闭自动滚屏">×</button>
</div>
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
      toast(text, ms = 1600) {
        mount();
        const el = root.querySelector('.toast');
        el.textContent = text;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), ms);
      },
    };
  })();

  // ---- 与 popup / 快捷键通信 ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'wrs:toggleAutoScroll') sendResponse({ running: toggleAutoScroll(), paged: isPaged() });
    else if (msg?.type === 'wrs:getAutoScroll') sendResponse({ running: auto.running, paged: isPaged() });
  });

  globalThis.WRSFlow = {
    update(s) {
      cfg.enabled = s.enabled;
      cfg.flowMode = s.flowMode;
      cfg.scrollSpeed = s.scrollSpeed;
      if (!s.enabled) {
        stopAutoScroll();
        hold?.release();
        dropHistory();
      }
      ui.renderBar();
    },
  };
})();
