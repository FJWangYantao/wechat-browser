/* 快捷键：Alt+Shift+W 开关自定义样式，Alt+Shift+S 开始 / 暂停自动滚屏 */
importScripts('shared/settings.js');

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-styles') {
    const current = await WRS.loadSettings();
    await WRS.saveSettings({ enabled: !current.enabled });
  } else if (command === 'toggle-autoscroll' && tab?.id) {
    // 非微信读书页面没有 content script，忽略错误即可
    chrome.tabs.sendMessage(tab.id, { type: 'wrs:toggleAutoScroll' }).catch(() => {});
  }
});
