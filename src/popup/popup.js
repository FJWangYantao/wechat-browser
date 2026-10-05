(() => {
  'use strict';
  const { PRESETS, FONTS, DEFAULTS, STORAGE_KEY, loadSettings } = globalThis.WRS;

  const $ = (id) => document.getElementById(id);
  const CUSTOM_FONT = '__custom__';

  let state = null;
  let saveTimer = 0;

  // 输入频繁的控件（滑块、文本框）防抖写入；页面通过 storage.onChanged 实时更新。
  function flush() {
    clearTimeout(saveTimer);
    chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  function update(patch, { debounce = false, render: rerender = true } = {}) {
    Object.assign(state, patch);
    if (rerender) render();
    if (debounce) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 200);
    } else {
      flush();
    }
  }

  function buildStatic() {
    const themes = $('themes');
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `theme ${p.id}`;
      btn.dataset.id = p.id;
      btn.textContent = p.name;
      if (p.bg) {
        btn.style.background = p.bg;
        btn.style.color = p.text;
      }
      btn.addEventListener('click', () => update({ theme: p.id, bgColor: p.bg, textColor: p.text }));
      themes.appendChild(btn);
    }

    const select = $('fontPreset');
    for (const f of [...FONTS, { name: '自定义…', value: CUSTOM_FONT }]) {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.name;
      select.appendChild(opt);
    }
  }

  function render() {
    const s = state;
    $('enabled').checked = s.enabled;
    $('panel').classList.toggle('disabled', !s.enabled);

    for (const btn of document.querySelectorAll('.theme')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.id === s.theme));
    }

    $('bgColor').value = s.bgColor || '#ffffff';
    $('textColor').value = s.textColor || '#000000';
    $('recolorText').checked = s.recolorText;

    const preset = FONTS.find((f) => f.value === s.fontFamily);
    $('fontPreset').value = preset ? preset.value : CUSTOM_FONT;
    if (document.activeElement !== $('fontFamily')) $('fontFamily').value = s.fontFamily;

    $('contentWidth').value = s.contentWidth || 800;
    $('widthValue').textContent = s.contentWidth ? `${s.contentWidth}px` : '原版';
    $('immersive').checked = s.immersive;

    $('flowMode').checked = s.flowMode;
    $('scrollSpeed').value = s.scrollSpeed;
    $('speedValue').textContent = `${s.scrollSpeed} px/s`;

    if (document.activeElement !== $('customCss')) $('customCss').value = s.customCss;
  }

  function bind() {
    $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));

    $('bgColor').addEventListener('input', (e) => update({ theme: 'custom', bgColor: e.target.value }, { debounce: true }));
    $('textColor').addEventListener('input', (e) => update({ theme: 'custom', textColor: e.target.value }, { debounce: true }));
    $('recolorText').addEventListener('change', (e) => update({ recolorText: e.target.checked }));

    $('fontPreset').addEventListener('change', (e) => {
      if (e.target.value === CUSTOM_FONT) {
        $('fontFamily').focus();
        return;
      }
      $('fontFamily').value = e.target.value;
      update({ fontFamily: e.target.value });
    });
    $('fontFamily').addEventListener('input', (e) => update({ fontFamily: e.target.value.trim() }, { debounce: true }));

    $('contentWidth').addEventListener('input', (e) => update({ contentWidth: Number(e.target.value) }, { debounce: true }));
    $('widthReset').addEventListener('click', () => update({ contentWidth: 0 }));
    $('immersive').addEventListener('change', (e) => update({ immersive: e.target.checked }));

    $('flowMode').addEventListener('change', (e) => update({ flowMode: e.target.checked }));
    $('scrollSpeed').addEventListener('input', (e) => update({ scrollSpeed: Number(e.target.value) }, { debounce: true }));
    $('autoScroll').addEventListener('click', toggleAutoScroll);

    $('customCss').addEventListener('input', (e) => update({ customCss: e.target.value }, { debounce: true, render: false }));

    // 松手 / 失焦时立即保存，避免关闭弹窗时丢掉防抖中的修改。
    for (const id of ['bgColor', 'textColor', 'fontFamily', 'contentWidth', 'scrollSpeed', 'customCss']) {
      $(id).addEventListener('change', flush);
    }

    $('reset').addEventListener('click', () => {
      state = Object.assign({}, DEFAULTS);
      update({});
    });
  }

  // 自动滚屏是页面上的运行时状态，不存进配置，直接和当前标签页通信。
  async function sendToTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {
      return null; // 不是微信读书页面
    }
  }

  function renderAutoScroll(res) {
    const btn = $('autoScroll');
    btn.disabled = !res;
    btn.textContent = res?.running ? '暂停自动滚屏' : '开始自动滚屏';
    const hint = $('autoScrollHint');
    if (!res) hint.textContent = '请在微信读书阅读页中使用';
    else if (res.paged) hint.textContent = '当前是双栏翻页模式，先点页面右侧的「单双栏切换」按钮切到单栏';
    hint.classList.toggle('warn', !!res?.paged);
  }

  async function toggleAutoScroll() {
    flush();
    const res = await sendToTab({ type: 'wrs:toggleAutoScroll' });
    renderAutoScroll(res);
    if (res?.running) window.close();
  }

  buildStatic();
  bind();
  loadSettings().then((s) => {
    state = s;
    render();
  });
  sendToTab({ type: 'wrs:getAutoScroll' }).then(renderAutoScroll);
})();
