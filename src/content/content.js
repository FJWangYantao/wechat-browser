/*
 * 隔离环境 content script：读取配置 -> 注入 <style> + 把 canvas 相关配置转发给 page-hook.js。
 *
 * 微信读书改版时最可能失效的是下面的选择器，集中放在 SEL 里方便调整。
 */
(() => {
  'use strict';
  const { STORAGE_KEY, mergeSettings, loadSettings, normalizeFontFamily } = globalThis.WRS;

  const STYLE_ID = 'wrs-style';

  const SEL = {
    page: 'html, body, .readerContent, .readerContent .app_content, .renderTargetContainer, .wr_canvasContainer',
    topBar: '.readerTopBar',
    controls: '.readerControls',
    footer: '.readerFooter',
    column: '.readerContent .app_content',
    // 旧版 / 滚动模式下正文是 DOM 文本
    domText: '.readerChapterContent',
  };

  let settings = null;
  let layoutKey = '';

  function buildCss(s) {
    if (!s.enabled) return '';
    const font = normalizeFontFamily(s.fontFamily);
    const out = [];

    const vars = [
      s.bgColor && `--wrs-bg: ${s.bgColor};`,
      s.textColor && `--wrs-text: ${s.textColor};`,
      font && `--wrs-font: ${font};`,
      s.contentWidth && `--wrs-width: ${s.contentWidth}px;`,
    ].filter(Boolean);
    if (vars.length) out.push(`:root {\n  ${vars.join('\n  ')}\n}`);

    if (s.bgColor) {
      out.push(`${SEL.page}, ${SEL.topBar}, ${SEL.footer}, ${SEL.domText} {
  background-color: var(--wrs-bg) !important;
  background-image: none !important;
}`);
    }

    if (s.textColor) {
      out.push(`${SEL.domText}, ${SEL.domText} *, ${SEL.topBar}, ${SEL.footer} {
  color: var(--wrs-text) !important;
}`);
    }

    if (font) {
      out.push(`${SEL.domText}, ${SEL.domText} * {
  font-family: var(--wrs-font) !important;
}`);
    }

    if (s.contentWidth) {
      out.push(`${SEL.column}, ${SEL.topBar} {
  max-width: min(var(--wrs-width), calc(100vw - var(--wrs-ai-w, 0px) - 48px)) !important;
  width: 100% !important;
}`);
    }

    // 右侧工具按钮在双栏模式下会压在正文上，统一挪到窗口右边缘、垂直居中。
    out.push(`${SEL.controls} {
  position: fixed !important;
  left: auto !important;
  right: calc(var(--wrs-ai-w, 0px) + 20px) !important;
  margin-left: 0 !important;
  top: 50% !important;
  bottom: auto !important;
  transform: translateY(-50%) !important;
}`);

    // 隐藏的顶栏仍占着位置，鼠标扫过就会触发 :hover。
    // 显示前加一段延迟，只有停留一会儿才出现；移开时立即淡出。
    if (s.immersive) {
      out.push(`${SEL.topBar}, ${SEL.controls} {
  opacity: 0 !important;
  transition: opacity .2s ease, right .22s ease !important;
}
${SEL.topBar}:hover, ${SEL.controls}:hover {
  opacity: 1 !important;
  transition: opacity .2s ease .5s, right .22s ease !important;
}`);
    }

    // 双栏模式下横向滑动用来翻页，禁掉浏览器“横滑返回上一页”的手势
    if (s.flowMode) out.push(`html, body { overscroll-behavior-x: none !important; }`);

    if (s.customCss) out.push(`/* 自定义 CSS */\n${s.customCss}`);
    return out.join('\n\n');
  }

  function applyStyle(css) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  function canvasConfig(s) {
    return {
      enabled: s.enabled,
      fontFamily: normalizeFontFamily(s.fontFamily),
      textColor: s.recolorText ? s.textColor : '',
      bgColor: s.bgColor,
    };
  }

  function pushToPage(s) {
    document.dispatchEvent(new CustomEvent('wrs:settings', { detail: JSON.stringify(canvasConfig(s)) }));
  }

  // canvas 内容只有重新排版才会重绘，触发一次 resize 让阅读器重新渲染。
  function relayoutIfNeeded(s) {
    const key = JSON.stringify([canvasConfig(s), s.contentWidth]);
    // 首次读取配置前若画布已绘制过，同样需要重绘一次
    const changed = layoutKey ? key !== layoutKey : !!document.querySelector('canvas');
    if (changed) {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
    layoutKey = key;
  }

  function apply(s) {
    settings = s;
    applyStyle(buildCss(s));
    pushToPage(s);
    relayoutIfNeeded(s);
    globalThis.WRSFlow?.update(s);
    globalThis.WRSAi?.update(s);
  }

  document.addEventListener('wrs:hello', () => settings && pushToPage(settings));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) apply(mergeSettings(changes[STORAGE_KEY].newValue));
  });

  loadSettings().then(apply);

  // <head> 在 document_start 时还不存在，DOM 就绪后把样式挪到 head 末尾，保证优先级。
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById(STYLE_ID);
    if (el && document.head) document.head.appendChild(el);
  });
})();
