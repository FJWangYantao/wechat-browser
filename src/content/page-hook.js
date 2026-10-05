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
      if (cfg.enabled && cfg.bgColor && this.canvas && typeof this.fillStyle === 'string') {
        const t = this.getTransform();
        const area = Math.abs(w * t.a * h * t.d);
        const canvasArea = this.canvas.width * this.canvas.height;
        if (canvasArea > 0 && area >= canvasArea * 0.9) {
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

  // content.js 可能比本脚本先拿到配置，主动要一次。
  document.dispatchEvent(new CustomEvent('wrs:hello'));
})();
