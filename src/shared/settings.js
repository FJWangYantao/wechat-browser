/*
 * 共享配置：popup、content script、service worker 共用。
 * 以经典脚本方式加载，挂到 globalThis.WRS 上。
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'settings';

  // 主题预设。bg/text 为空表示保持微信读书原样。
  const PRESETS = [
    { id: 'none', name: '原版', bg: '', text: '' },
    { id: 'paper', name: '纸张', bg: '#f6f1e7', text: '#2b2b2b' },
    { id: 'sepia', name: '羊皮纸', bg: '#f4ecd8', text: '#5b4636' },
    { id: 'green', name: '护眼', bg: '#cce8cf', text: '#1f2d1f' },
    { id: 'gray', name: '雾灰', bg: '#e6e6e3', text: '#333333' },
    { id: 'night', name: '夜间', bg: '#1b1d20', text: '#a9adb3' },
  ];

  // 字体预设。需要本机已安装对应字体才会生效。
  const FONTS = [
    { name: '原版字体', value: '' },
    { name: '霞鹜文楷', value: 'LXGW WenKai Screen, LXGW WenKai' },
    { name: '思源宋体', value: 'Source Han Serif SC, Noto Serif CJK SC, Songti SC, serif' },
    { name: '思源黑体', value: 'Source Han Sans SC, Noto Sans CJK SC, PingFang SC, sans-serif' },
    { name: '苹方', value: 'PingFang SC, sans-serif' },
    { name: '微软雅黑', value: 'Microsoft YaHei, sans-serif' },
    { name: '楷体', value: 'KaiTi, STKaiti, Kaiti SC, serif' },
    { name: '仿宋', value: 'FangSong, STFangsong, serif' },
  ];

  const DEFAULTS = {
    enabled: true,
    theme: 'paper',
    bgColor: '#f6f1e7',
    textColor: '#2b2b2b',
    recolorText: true, // 同时重绘 canvas 正文颜色
    fontFamily: '', // 空 = 原版字体
    contentWidth: 0, // px，0 = 原版宽度
    immersive: false, // 顶栏、侧边按钮悬停才显示
    customCss: '',
  };

  const GENERIC_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  ]);

  // "LXGW WenKai, serif" -> "\"LXGW WenKai\", serif"，可直接用于 CSS 与 canvas font。
  function normalizeFontFamily(input) {
    if (!input) return '';
    return String(input)
      .split(',')
      .map((name) => name.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
      .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name.replace(/"/g, '')}"`))
      .join(', ');
  }

  function mergeSettings(stored) {
    return Object.assign({}, DEFAULTS, stored || {});
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return mergeSettings(data[STORAGE_KEY]);
  }

  async function saveSettings(patch) {
    const next = Object.assign(await loadSettings(), patch);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  root.WRS = {
    STORAGE_KEY,
    PRESETS,
    FONTS,
    DEFAULTS,
    normalizeFontFamily,
    mergeSettings,
    loadSettings,
    saveSettings,
  };
})(globalThis);
