/* 快捷键 Alt+Shift+W：一键开关自定义样式 */
importScripts('shared/settings.js');

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-styles') return;
  const current = await WRS.loadSettings();
  await WRS.saveSettings({ enabled: !current.enabled });
});
