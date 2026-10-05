# 微信读书样式定制（Chrome 插件）

给 [微信读书网页版](https://weread.qq.com) 换一套你自己的阅读样式：背景色、文字颜色、字体、版心宽度、沉浸模式，外加任意自定义 CSS。

## 功能

| 功能 | 说明 |
| --- | --- |
| 主题预设 | 原版 / 纸张 / 羊皮纸 / 护眼 / 雾灰 / 夜间，一键切换 |
| 自定义颜色 | 背景色、正文文字色任意调整 |
| 字体替换 | 霞鹜文楷、思源宋体等预设，或填写任意本机字体名 |
| 版心宽度 | 600–1800px 可调，宽屏阅读不再两侧大片留白 |
| 沉浸模式 | 顶栏和右侧按钮默认隐藏，鼠标悬停时出现 |
| 自定义 CSS | 高级用户可直接写 CSS 覆盖任意元素 |
| 快捷键 | `Alt+Shift+W` 一键开关全部样式 |

修改会实时作用到已打开的阅读页，配置保存在 `chrome.storage.local`。

## 安装（开发版）

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本仓库根目录
3. 打开微信读书任意一本书，点工具栏里的插件图标调整样式

需要 Chrome 111 及以上（用到了 content script 的 `"world": "MAIN"`）。

## 实现原理

微信读书网页版的正文是画在 `<canvas>` 上的，光靠 CSS 改不了文字本身，所以插件分两层：

```
manifest.json
src/
  shared/settings.js     默认配置、主题与字体预设（popup / content / 后台共用）
  content/content.js     隔离环境：读配置 → 注入 <style>，并把 canvas 相关配置转发给页面
  content/page-hook.js   页面主环境：拦截 CanvasRenderingContext2D
  popup/                 弹窗设置界面
  background.js          快捷键开关
```

- **CSS 层**（`content.js`）：背景、顶栏、版心宽度、沉浸模式、DOM 渲染的正文（旧版/滚动模式）。
- **Canvas 层**（`page-hook.js`，`document_start` 注入页面主环境）：
  - 重写 `ctx.font` 的 setter，把自定义字体插到字体族最前面。`measureText` 也走同一个 font，所以排版不会错位。
  - 包装 `fillText`，只把**中性色（灰/黑/白）**文字换成自定义颜色，链接、划线批注等彩色文字保持原样。
  - 包装 `fillRect`，铺满整个画布的矩形视为背景，换成自定义背景色。
- 改动字体、颜色、宽度后会派发一次 `resize` 事件，让阅读器重新排版重绘。

## 微信读书改版后怎么修

最可能失效的是 CSS 选择器，都集中在 `src/content/content.js` 顶部的 `SEL` 对象里：

```js
const SEL = {
  page: 'html, body, .readerContent, .readerContent .app_content, ...',
  topBar: '.readerTopBar',
  controls: '.readerControls',
  ...
};
```

在阅读页按 F12 找到新的类名替换即可；临时应急也可以直接在弹窗的「自定义 CSS」里写。

## 已知限制

- 选择器是按目前已知的微信读书页面结构写的，**尚未在真实页面上逐项验证**；canvas 拦截逻辑已用模拟页面测试通过。如有元素没被覆盖，请按上节调整。
- 字体必须是本机已安装的字体（canvas 无法使用未加载的网络字体）。
- 字号、行距仍请使用微信读书自带的设置：canvas 排版由阅读器自己计算，插件强改会导致错位。
- 修改后如果正文没有立即刷新，翻一页或刷新页面即可。

## 后续可以做

- [ ] 加载自定义网络字体 / 上传字体文件（通过 `FontFace` 注入后再重绘）
- [ ] 按书单独保存样式
- [ ] 配置导入导出、多设备同步（`chrome.storage.sync`）
- [ ] 段间距、首行缩进等 canvas 排版级别的调整
