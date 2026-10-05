/*
 * 运行在页面主环境（MAIN world），document_start 注入。
 *
 * 微信读书网页版正文用 <canvas> 绘制，CSS 改不到文字本身，
 * 所以这里拦截 CanvasRenderingContext2D：
 *   - font 赋值时把自定义字体插到字体族最前面（measureText 同样生效，排版不会错位）
 *   - fillText 时把“中性色”文字换成自定义文字色（彩色的链接、批注标记保持原样）
 *   - 铺满画布的 fillRect 换成自定义背景色
 *
 * 配置由 content.js（隔离环境）通过 CustomEvent 传入。
 *
 * 另外记录 fillText 画了哪些字、画在哪里，用于 AI 陪读的“划选取词”：
 * 画布上没有真正的文字选区，拖选结束后按鼠标起止位置从记录里还原出选中的文字。
 */
(() => {
  'use strict';
  if (window.__wrsHooked) return;
  window.__wrsHooked = true;

  const cfg = { enabled: false, fontFamily: '', textColor: '', bgColor: '' };

  // "italic 700 18px/1.5 PingFang SC" -> ["italic 700 18px/1.5 ", "PingFang SC"]
  const FONT_RE = /^(.*?\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|q|mm|cm|in)(?:\s*\/\s*\S+)?\s+)(.+)$/i;

  function parseColor(str) {
    if (typeof str !== 'string') return null;
    let m = /^#([0-9a-f]{6})$/i.exec(str);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    return null;
  }

  function isNeutral(c) {
    return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 32;
  }

  function withAlpha(hex, a) {
    const c = parseColor(hex);
    if (!c) return hex;
    return a >= 1 ? hex : `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
  }

  // ---- 正文文字索引 ----

  const textIndex = (() => {
    const byCanvas = new Map(); // HTMLCanvasElement -> Map(位置 -> 文字片段)
    const MAX_RUNS = 20000;
    const CONTEXT_CHARS = 800;
    const FONT_SIZE_RE = /(\d*\.?\d+)px/;
    // textBaseline -> 基线到字顶的距离（以字号为单位）
    const ASCENT = { top: 0, hanging: 0, middle: 0.5, bottom: 1, ideographic: 1, alphabetic: 0.85 };
    const isWordChar = (c) => /[A-Za-z0-9]/.test(c || '');

    function record(ctx, text, x, y) {
      const canvas = ctx.canvas;
      if (!(canvas instanceof HTMLCanvasElement) || typeof text !== 'string' || !text.trim()) return;
      const t = ctx.getTransform();
      const scale = Math.hypot(t.a, t.b) || 1;
      const size = (parseFloat((FONT_SIZE_RE.exec(ctx.font) || [])[1]) || 16) * scale;
      const w = ctx.measureText(text).width * scale;
      let left = t.a * x + t.c * y + t.e;
      const base = t.b * x + t.d * y + t.f;
      const rtl = ctx.direction === 'rtl';
      const align = ctx.textAlign;
      if (align === 'center') left -= w / 2;
      else if (align === 'right' || (align === 'end' && !rtl) || (align === 'start' && rtl)) left -= w;
      const top = base - size * (ASCENT[ctx.textBaseline] ?? 0.85);

      let runs = byCanvas.get(canvas);
      if (!runs) byCanvas.set(canvas, (runs = new Map()));
      if (runs.size > MAX_RUNS) runs.clear();
      // 同一位置重绘会覆盖旧记录
      runs.set(`${Math.round(left)},${Math.round(top)}`, { text, x: left, y: top, w, h: size });
    }

    function reset(canvas) {
      byCanvas.delete(canvas);
    }

    // 一张画布上的文字 -> 按阅读顺序排好的行（先分栏，再按行）
    function linesOf(items, page) {
      const hs = items.map((it) => it.h).sort((a, b) => a - b);
      const h = hs[hs.length >> 1] || 16;

      // 分栏：把所有文字的横向区间合并，中间留有大空隙的就是不同的栏
      const spans = items.map((it) => [it.x, it.x + it.w]).sort((a, b) => a[0] - b[0]);
      const clusters = [];
      for (const [l, r] of spans) {
        const last = clusters[clusters.length - 1];
        if (last && l - last[1] < h * 2) last[1] = Math.max(last[1], r);
        else clusters.push([l, r]);
      }
      const columns = clusters.filter(([l, r]) => r - l > h * 6);
      if (!columns.length) columns.push(clusters[0]);
      const colOf = (it) => {
        const cx = it.x + it.w / 2;
        let best = 0;
        let bestD = Infinity;
        columns.forEach(([l, r], i) => {
          const d = cx < l ? l - cx : cx > r ? cx - r : 0;
          if (d < bestD) [best, bestD] = [i, d];
        });
        return best;
      };

      const lines = [];
      columns.forEach(([colLeft], col) => {
        const colItems = items.filter((it) => colOf(it) === col).sort((a, b) => a.y - b.y);
        const rows = [];
        for (const it of colItems) {
          const row = rows[rows.length - 1];
          if (row && Math.abs(it.y - row.y) < row.h * 0.5) {
            row.items.push(it);
            row.h = Math.max(row.h, it.h);
          } else {
            rows.push({ y: it.y, h: it.h, items: [it] });
          }
        }
        for (const row of rows) {
          row.items.sort((a, b) => a.x - b.x);
          const last = row.items[row.items.length - 1];
          lines.push({ page, col, colLeft, items: row.items, x: row.items[0].x, y: row.y, w: last.x + last.w - row.items[0].x, h: row.h });
        }
      });
      return lines;
    }

    function layout() {
      const pages = [];
      for (const [canvas, runs] of byCanvas) {
        if (!canvas.isConnected) {
          byCanvas.delete(canvas);
          continue;
        }
        const r = canvas.getBoundingClientRect();
        if (!runs.size || !r.width || !r.height || !canvas.width || !canvas.height) continue;
        const sx = r.width / canvas.width;
        const sy = r.height / canvas.height;
        const items = [...runs.values()].map((u) => ({ text: u.text, x: r.left + u.x * sx, y: r.top + u.y * sy, w: u.w * sx, h: u.h * sy }));
        pages.push({ r, items });
      }
      pages.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
      return pages.flatMap((p, i) => linesOf(p.items, i));
    }

    // 行与行之间：换段落用换行，英文单词断行补空格，中文直接相连
    function separator(a, b, prevChar, nextChar) {
      const indented = b.x - b.colLeft > b.h * 1.2;
      const gap = b.page === a.page && b.col === a.col ? b.y - (a.y + a.h) : 0;
      if (indented || gap > a.h * 1.2) return '\n';
      return isWordChar(prevChar) && isWordChar(nextChar) ? ' ' : '';
    }

    // 展开成逐字数组，记录每个字所在的行和横向位置
    function chars(lines) {
      const out = [];
      lines.forEach((line, li) => {
        if (li > 0) {
          const sep = separator(lines[li - 1], line, out.length ? out[out.length - 1].c : '', line.items[0].text[0]);
          if (sep) out.push({ c: sep, line: -1 });
        }
        let lastRight = null;
        for (const it of line.items) {
          const cs = [...it.text];
          const cw = it.w / cs.length;
          if (lastRight !== null && it.x - lastRight > it.h * 0.15 && isWordChar(out[out.length - 1].c) && isWordChar(cs[0])) {
            out.push({ c: ' ', line: -1 });
          }
          cs.forEach((c, i) => out.push({ c, line: li, cx: it.x + cw * (i + 0.5), cw }));
          lastRight = it.x + it.w;
        }
      });
      return out;
    }

    const join = (list) => list.map((ch) => ch.c).join('');

    function hitLine(lines, p) {
      let best = -1;
      let bestD = Infinity;
      lines.forEach((l, i) => {
        const dy = p.y < l.y ? l.y - p.y : p.y > l.y + l.h ? p.y - l.y - l.h : 0;
        const dx = p.x < l.x ? l.x - p.x : p.x > l.x + l.w ? p.x - l.x - l.w : 0;
        const d = dy * 4 + dx;
        if (d < bestD) [best, bestD] = [i, d];
      });
      return best >= 0 && bestD <= lines[best].h * 6 ? best : -1;
    }

    function charIndex(list, line, x, edge) {
      let first = -1;
      let last = -1;
      for (let k = 0; k < list.length; k++) {
        if (list[k].line !== line) continue;
        if (first < 0) first = k;
        last = k;
        if (edge === 'start' && list[k].cx + list[k].cw / 2 > x) return k;
      }
      if (edge === 'start') return last + 1;
      for (let k = last; k >= first; k--) if (list[k].cx - list[k].cw / 2 < x) return k;
      return first - 1;
    }

    function withContext(list, i, j) {
      return {
        text: join(list.slice(i, j + 1)).trim(),
        before: join(list.slice(Math.max(0, i - CONTEXT_CHARS), i)),
        after: join(list.slice(j + 1, j + 1 + CONTEXT_CHARS)),
      };
    }

    return {
      record,
      reset,

      // 鼠标从 a 拖到 b（视口坐标）选中的文字及前后文
      select(a, b) {
        const lines = layout();
        let la = hitLine(lines, a);
        let lb = hitLine(lines, b);
        if (la < 0 || lb < 0) return null;
        if (la > lb || (la === lb && a.x > b.x)) [a, b, la, lb] = [b, a, lb, la];
        const list = chars(lines);
        const i = charIndex(list, la, a.x, 'start');
        const j = charIndex(list, lb, b.x, 'end');
        return i <= j ? withContext(list, i, j) : null;
      },

      // 已知选中文字（例如阅读器「复制」出来的），从正文里找出前后文
      contextOf(text) {
        const list = chars(layout());
        const i = join(list).indexOf(text.trim());
        return i >= 0 ? withContext(list, i, i + text.trim().length - 1) : { text: text.trim(), before: '', after: '' };
      },

      visibleText() {
        const lines = layout().filter((l) => l.y + l.h > 0 && l.y < window.innerHeight);
        return join(chars(lines)).trim();
      },
    };
  })();

  function coversCanvas(ctx, w, h) {
    if (!ctx.canvas) return false;
    const t = ctx.getTransform();
    const canvasArea = ctx.canvas.width * ctx.canvas.height;
    return canvasArea > 0 && Math.abs(w * t.a * h * t.d) >= canvasArea * 0.9;
  }

  function hook(proto) {
    if (!proto) return;

    const fontDesc = Object.getOwnPropertyDescriptor(proto, 'font');
    if (fontDesc && fontDesc.set) {
      Object.defineProperty(proto, 'font', {
        configurable: true,
        enumerable: fontDesc.enumerable,
        get() {
          return fontDesc.get.call(this);
        },
        set(value) {
          if (cfg.enabled && cfg.fontFamily && typeof value === 'string') {
            const m = FONT_RE.exec(value);
            if (m && !m[2].startsWith(cfg.fontFamily)) value = `${m[1]}${cfg.fontFamily}, ${m[2]}`;
          }
          fontDesc.set.call(this, value);
        },
      });
    }

    const fillText = proto.fillText;
    proto.fillText = function (...args) {
      try {
        textIndex.record(this, args[0], args[1], args[2]);
      } catch (_) {
        /* 记录失败不影响绘制 */
      }
      if (cfg.enabled && cfg.textColor) {
        const prev = this.fillStyle;
        const c = parseColor(prev);
        if (c && isNeutral(c)) {
          this.fillStyle = withAlpha(cfg.textColor, c.a);
          try {
            return fillText.apply(this, args);
          } finally {
            this.fillStyle = prev;
          }
        }
      }
      return fillText.apply(this, args);
    };

    const fillRect = proto.fillRect;
    proto.fillRect = function (x, y, w, h) {
      if (coversCanvas(this, w, h)) {
        textIndex.reset(this.canvas); // 整张重绘，旧的文字记录作废
        if (cfg.enabled && cfg.bgColor && typeof this.fillStyle === 'string') {
          const prev = this.fillStyle;
          this.fillStyle = cfg.bgColor;
          try {
            return fillRect.call(this, x, y, w, h);
          } finally {
            this.fillStyle = prev;
          }
        }
      }
      return fillRect.call(this, x, y, w, h);
    };

    const clearRect = proto.clearRect;
    proto.clearRect = function (x, y, w, h) {
      if (coversCanvas(this, w, h)) textIndex.reset(this.canvas);
      return clearRect.call(this, x, y, w, h);
    };
  }

  // 改画布尺寸会清空画布
  for (const prop of ['width', 'height']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
    if (!desc || !desc.set) continue;
    Object.defineProperty(HTMLCanvasElement.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        textIndex.reset(this);
        desc.set.call(this, value);
      },
    });
  }

  hook(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);
  hook(window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype);

  document.addEventListener('wrs:settings', (e) => {
    try {
      Object.assign(cfg, JSON.parse(e.detail));
    } catch (_) {
      /* 忽略格式错误的消息 */
    }
  });

  // ---- 划选取词：拖选结束后把选中文字发给 ai.js ----

  const OWN_UI = '#wrs-ai, #wrs-flow, #wrs-history';
  const emit = (type, data) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));
  const isOwnUi = (e) => e.target instanceof Element && !!e.target.closest(OWN_UI);
  const pointer = { x: 0, y: 0 };
  let dragStart = null;

  // DOM 渲染的正文（旧版）直接用浏览器选区
  function domSelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text || !sel.rangeCount) return null;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const block = (node.nodeType === 1 ? node : node.parentElement)?.closest('p, div, section, article');
    const all = block ? block.textContent : '';
    const i = all.indexOf(text);
    return i < 0 ? { text, before: '', after: '' } : { text, before: all.slice(Math.max(0, i - 800), i), after: all.slice(i + text.length, i + text.length + 800) };
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      dragStart = e.button === 0 && !isOwnUi(e) ? { x: e.clientX, y: e.clientY } : null;
    },
    true,
  );

  document.addEventListener(
    'mouseup',
    (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      const start = dragStart;
      dragStart = null;
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      const end = { x: e.clientX, y: e.clientY };
      setTimeout(() => {
        const sel = domSelection() || textIndex.select(start, end);
        if (sel && sel.text) emit('wrs:selection', { ...sel, x: end.x, y: end.y });
      }, 0);
    },
    true,
  );

  // 兜底：用阅读器自带的「复制」时，截下复制的文字
  function onCopied(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    setTimeout(() => emit('wrs:selection', { ...textIndex.contextOf(text), x: pointer.x, y: pointer.y, source: 'copy' }), 0);
  }

  const setData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (format, data) {
    if (/^text(\/plain)?$/i.test(format)) onCopied(data);
    return setData.call(this, format, data);
  };
  if (window.Clipboard && Clipboard.prototype.writeText) {
    const writeText = Clipboard.prototype.writeText;
    Clipboard.prototype.writeText = function (text) {
      onCopied(text);
      return writeText.call(this, text);
    };
  }

  // ai.js 同步索取当前屏幕上的正文
  document.addEventListener('wrs:request', (e) => {
    let req = null;
    try {
      req = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (req?.type === 'visibleText') emit('wrs:response', { text: textIndex.visibleText() });
  });

  // content.js 可能比本脚本先拿到配置，主动要一次。
  document.dispatchEvent(new CustomEvent('wrs:hello'));
})();
