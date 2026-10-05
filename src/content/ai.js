/*
 * AI 陪读（隔离环境 content script）：
 *   - 划选文字后在旁边出现「问 AI」按钮（选中文字由 page-hook.js 从画布记录中还原）
 *   - 右侧面板：引用原文、快捷提问、多轮追问，回答流式显示
 *   - 不选文字也能打开面板，针对当前屏幕上的内容提问
 *
 * 实际的模型调用在后台 service worker（background.js）里完成，这里通过 Port 收流式结果。
 */
(() => {
  'use strict';

  const SELECTION_ACTIONS = [
    { label: '解释', prompt: '请解释这段话的意思，以及它在上下文里想表达什么。' },
    { label: '大白话', prompt: '请用通俗的大白话把这段话重新讲一遍。' },
    { label: '背景知识', prompt: '这段话涉及哪些人物、事件或概念？请补充理解它所需的背景知识。' },
    { label: '延伸思考', prompt: '围绕这段话，有哪些值得进一步思考的问题，或者不同的观点？' },
  ];
  const PAGE_ACTIONS = [
    { label: '总结这一页', prompt: '请概括我当前这一页的主要内容。' },
    { label: '关键概念', prompt: '这一页里有哪些关键概念或人物？请逐个简要解释。' },
    { label: '考考我', prompt: '根据这一页的内容出 3 道思考题考考我，先不要给答案。' },
  ];

  const cfg = { enabled: true, aiSelectButton: true, dark: false };
  let lastSelection = null; // { text, before, after, at }
  let convo = null; // { quote, before, after, page, messages: [{ role, content }], display: [...] }
  let port = null;
  let keepAlive = 0;

  // ---- 与 page-hook.js 通信 ----

  document.addEventListener('wrs:selection', (e) => {
    let sel = null;
    try {
      sel = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!cfg.enabled || !sel || typeof sel.text !== 'string' || !sel.text.trim()) return;
    // 拖选和「复制」可能先后报告同一段文字
    if (lastSelection && lastSelection.text === sel.text && Date.now() - lastSelection.at < 2000 && sel.source === 'copy') return;
    lastSelection = { text: sel.text.slice(0, 4000), before: String(sel.before || ''), after: String(sel.after || ''), at: Date.now() };
    if (cfg.aiSelectButton) ui.showPill(Number(sel.x) || 0, Number(sel.y) || 0);
  });

  // CustomEvent 是同步派发的，page-hook.js 的回应会在 dispatchEvent 返回前到达
  function visibleText() {
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
    return text.slice(0, 6000);
  }

  function bookTitle() {
    const el = document.querySelector('.readerTopBar_title_link, .readerTopBar_title');
    const fromBar = el && el.textContent.trim();
    return fromBar || document.title.replace(/\s*[-–|]\s*微信读书.*$/, '').trim() || '（未知书名）';
  }

  // ---- 对话 ----

  function startConversation(selection) {
    stopStreaming();
    if (selection) {
      convo = { quote: selection.text, before: selection.before, after: selection.after, page: '', messages: [], display: [] };
    } else {
      convo = { quote: '', before: '', after: '', page: visibleText(), messages: [], display: [] };
    }
    ui.renderConversation();
  }

  // 第一轮把书名和原文一起发过去，之后的追问只发问题
  function firstUserMessage(question) {
    const title = bookTitle();
    if (convo.quote) {
      return `我正在读《${title}》。下面是当前位置附近的原文，【】里是我划选的部分：
<原文>
${convo.before}【${convo.quote}】${convo.after}
</原文>

${question}`;
    }
    if (convo.page) {
      return `我正在读《${title}》。这是我当前屏幕上的内容：
<原文>
${convo.page}
</原文>

${question}`;
    }
    return `我正在读《${title}》。${question}`;
  }

  function ask(question) {
    question = question.trim();
    if (!question || !convo || port) return;
    const content = convo.messages.length ? question : firstUserMessage(question);
    convo.messages.push({ role: 'user', content });
    convo.display.push({ role: 'user', text: question });
    const answer = { role: 'assistant', text: '', pending: true };
    convo.display.push(answer);

    port = chrome.runtime.connect({ name: 'wrs-ai' });
    ui.renderConversation();
    // service worker 只在收到事件时续命，长回答期间定时发心跳
    keepAlive = setInterval(() => port && port.postMessage({ type: 'ping' }), 15000);

    const finish = () => {
      clearInterval(keepAlive);
      answer.pending = false;
      const p = port;
      port = null;
      try {
        p && p.disconnect();
      } catch (_) {
        /* already closed */
      }
      ui.renderConversation();
    };

    port.onMessage.addListener((msg) => {
      if (msg.type === 'delta') {
        answer.text += msg.text;
        ui.updateAnswer(answer);
      } else if (msg.type === 'done') {
        if (msg.stopReason === 'refusal') answer.error = '模型拒绝回答了这个问题，换个问法试试。';
        else if (msg.stopReason === 'max_tokens') answer.error = '回答太长被截断了。';
        if (answer.text) convo.messages.push({ role: 'assistant', content: answer.text });
        finish();
      } else if (msg.type === 'error') {
        answer.error = msg.message;
        answer.needsKey = msg.code === 'no-key' || msg.code === 'auth';
        convo.messages.pop(); // 失败的这轮不计入上下文，方便重试
        finish();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!port) return;
      if (!answer.text && !answer.error) answer.error = '连接中断了，请重试。';
      finish();
    });
    port.postMessage({ type: 'ask', messages: convo.messages });
  }

  function stopStreaming() {
    if (!port) return;
    const p = port;
    port = null;
    clearInterval(keepAlive);
    try {
      p.disconnect(); // 后台据此中止请求
    } catch (_) {
      /* ignore */
    }
    const last = convo && convo.display[convo.display.length - 1];
    if (last && last.pending) {
      last.pending = false;
      if (last.text) convo.messages.push({ role: 'assistant', content: last.text });
      else convo.messages.pop();
    }
    ui.renderConversation();
  }

  // ---- 极简 Markdown（先转义，再处理少量语法） ----

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  }

  function markdown(src) {
    const out = [];
    const lines = src.replace(/\r/g, '').split('\n');
    let list = null; // 'ul' | 'ol'
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) {
        flushPara();
        closeList();
        const code = [];
        while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        out.push(`<h4>${inline(m[2])}</h4>`);
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)、]\s+(.*)$/.exec(line))) {
        flushPara();
        const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (list !== type) {
          closeList();
          out.push(`<${type}>`);
          list = type;
        }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return out.join('');
  }

  // ---- 打开面板时正文让位：页面右侧留出面板宽度，阅读区在剩余空间里居中 ----

  const pageLayout = (() => {
    const PANEL_WIDTH = 400;
    const MIN_READING_WIDTH = 560; // 剩余空间不够时，面板直接盖在页面上
    const STYLE_ID = 'wrs-ai-layout';
    const COLUMN = '.readerContent .app_content';
    const BUTTONS_GUTTER = 96; // 右侧工具按钮（宽 56、距边 20）两边各留出的空间
    // 这些元素如果是 fixed 且水平居中，就跟着往左挪半个面板宽
    const FIXED_CANDIDATES = '.readerTopBar, .readerFooter, .readerContent, .readerContent .app_content';
    let wanted = false;
    let width = 0;
    let settleTimer = 0;

    const CSS = `
body { transition: margin-right .22s ease; }
html[data-wrs-ai] body { margin-right: var(--wrs-ai-w) !important; }
html[data-wrs-ai] [data-wrs-ai-shift] { translate: calc(var(--wrs-ai-w) / -2) 0 !important; }
html[data-wrs-ai-fit] ${COLUMN} { max-width: calc(100vw - var(--wrs-ai-w) - ${BUTTONS_GUTTER * 2}px) !important; }
`;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }

    function markFixed() {
      for (const el of document.querySelectorAll('[data-wrs-ai-shift]')) el.removeAttribute('data-wrs-ai-shift');
      if (!width) return;
      const vw = window.innerWidth;
      for (const el of document.querySelectorAll(FIXED_CANDIDATES)) {
        if (getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw - 8 && Math.abs(r.left + r.width / 2 - vw / 2) < 8) el.setAttribute('data-wrs-ai-shift', '');
      }
    }

    // 过渡结束后：阅读区如果按视口宽度定死、仍然伸到右侧按钮或面板下面，就强制收窄；再让阅读器按新宽度重排
    function settle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const html = document.documentElement;
        html.removeAttribute('data-wrs-ai-fit');
        const col = width && document.querySelector(COLUMN);
        if (col && col.getBoundingClientRect().right > window.innerWidth - width - BUTTONS_GUTTER) html.setAttribute('data-wrs-ai-fit', '');
        window.dispatchEvent(new Event('resize'));
      }, 260);
    }

    function apply() {
      const next = wanted && window.innerWidth - PANEL_WIDTH >= MIN_READING_WIDTH ? PANEL_WIDTH : 0;
      if (next === width) return;
      width = next;
      ensureStyle();
      const html = document.documentElement;
      html.style.setProperty('--wrs-ai-w', `${width}px`);
      html.toggleAttribute('data-wrs-ai', width > 0);
      markFixed();
      settle();
    }

    window.addEventListener('resize', () => wanted && apply());

    return {
      set(open) {
        wanted = open;
        apply();
      },
    };
  })();

  // ---- 界面（Shadow DOM，不受页面样式影响） ----

  const ui = (() => {
    let host = null;
    let root = null;
    let pillTimer = 0;
    let renderQueued = false;

    const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.pill, .panel {
  --bg: #ffffff; --fg: #1f2328; --muted: #6b7178; --line: #e6e3dc; --soft: #f5f2ec;
  --accent: #1b88ee; --quote: #8a6d3b; --user: #eaf3fd;
  font: 14px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg);
}
.pill.dark, .panel.dark {
  --bg: #23262b; --fg: #e3e5e8; --muted: #9aa0a6; --line: #3a3e44; --soft: #2c3036;
  --quote: #d6b47a; --user: #22384f;
}
.pill {
  position: fixed; z-index: 2147483646; display: none; align-items: center; gap: 6px;
  padding: 6px 12px; border: 0; border-radius: 999px; cursor: pointer;
  background: #1f2328; color: #fff; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.18);
}
.pill.show { display: inline-flex; }
.pill:hover { background: #1b88ee; }
.panel {
  position: fixed; z-index: 2147483647; top: 0; right: 0; bottom: 0; width: min(400px, 100vw);
  display: flex; flex-direction: column; background: var(--bg);
  border-left: 1px solid var(--line); box-shadow: -8px 0 32px rgba(0,0,0,.08);
  transform: translateX(105%); transition: transform .22s ease;
}
.panel.open { transform: none; }
header {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line);
}
header .title { flex: 1; font-weight: 600; font-size: 15px; }
button { font: inherit; color: inherit; }
.icon, .ghost {
  border: 0; background: none; cursor: pointer; border-radius: 6px; color: var(--muted);
}
.icon { width: 28px; height: 28px; font-size: 18px; line-height: 28px; }
.ghost { padding: 3px 8px; font-size: 12px; }
.icon:hover, .ghost:hover { background: var(--soft); color: var(--fg); }
.body { flex: 1; overflow-y: auto; padding: 14px; overscroll-behavior: contain; }
.quote {
  margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid var(--quote); background: var(--soft);
  border-radius: 0 6px 6px 0; color: var(--fg); font-size: 13px; white-space: pre-wrap;
  max-height: 9.5em; overflow-y: auto;
}
.context-note { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.chip {
  padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg);
  font-size: 13px; cursor: pointer;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip:disabled { opacity: .5; cursor: default; }
.msg { margin: 0 0 14px; }
.msg.user {
  margin-left: 15%; padding: 8px 12px; border-radius: 10px; background: var(--user); white-space: pre-wrap;
}
.msg.assistant :first-child { margin-top: 0; }
.msg.assistant :last-child { margin-bottom: 0; }
.msg.assistant p { margin: 0 0 .6em; }
.msg.assistant ul, .msg.assistant ol { margin: 0 0 .6em; padding-left: 1.4em; }
.msg.assistant h4 { margin: .8em 0 .3em; font-size: 14px; }
.msg.assistant blockquote { margin: 0 0 .6em; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
.msg.assistant code { padding: 1px 4px; border-radius: 4px; background: var(--soft); font-size: 12.5px; }
.msg.assistant pre { padding: 8px 10px; border-radius: 6px; background: var(--soft); overflow-x: auto; }
.msg.assistant pre code { padding: 0; background: none; }
.thinking { color: var(--muted); font-size: 13px; }
.thinking::after { content: '…'; animation: blink 1.2s steps(3) infinite; }
@keyframes blink { 50% { opacity: .3; } }
.error { margin-top: 6px; padding: 8px 10px; border-radius: 6px; background: rgba(217,130,43,.12); color: #b4641c; font-size: 13px; }
.empty { color: var(--muted); font-size: 13px; }
.empty b { color: var(--fg); font-weight: 600; }
form { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px 14px; border-top: 1px solid var(--line); }
textarea {
  flex: 1; min-height: 38px; max-height: 140px; padding: 8px 10px; resize: none;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg);
  font: inherit; font-size: 14px; line-height: 1.5;
}
textarea:focus { outline: 2px solid rgba(27,136,238,.35); border-color: var(--accent); }
.send {
  height: 38px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer;
}
.send.stop { background: var(--muted); }
.send:disabled { opacity: .5; cursor: default; }
@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
`;

    function mount() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'wrs-ai';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${STYLE}</style>
<button class="pill" type="button">✦ 问 AI</button>
<aside class="panel" aria-label="AI 陪读">
  <header>
    <span class="title">AI 陪读</span>
    <button class="ghost reset" type="button" title="清空对话，针对当前屏幕重新开始">新对话</button>
    <button class="icon close" type="button" title="关闭 (Esc)" aria-label="关闭">×</button>
  </header>
  <div class="body"></div>
  <form>
    <textarea rows="1" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button class="send" type="submit">发送</button>
  </form>
</aside>`;

      // 面板里的按键、滚轮、点击不要传给阅读器（翻页、划线、连续滚动都会误触发）
      for (const type of ['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'mouseup', 'click', 'copy']) {
        host.addEventListener(type, (e) => e.stopPropagation());
      }

      const pill = root.querySelector('.pill');
      pill.addEventListener('mousedown', (e) => e.preventDefault()); // 不让阅读器的选区被清掉
      pill.addEventListener('click', () => {
        hidePill();
        if (!lastSelection) return;
        startConversation(lastSelection);
        open();
      });

      root.querySelector('.close').addEventListener('click', close);
      root.querySelector('.reset').addEventListener('click', () => startConversation(null));
      root.querySelector('.body').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip && !chip.disabled) ask(chip.dataset.prompt);
      });

      const textarea = root.querySelector('textarea');
      const form = root.querySelector('form');
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 140)}px`;
      });
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        } else if (e.key === 'Escape') {
          close();
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (port) return stopStreaming();
        if (!convo) startConversation(null);
        const q = textarea.value;
        if (!q.trim()) return;
        textarea.value = '';
        textarea.style.height = '';
        ask(q);
      });

      document.addEventListener('mousedown', hidePill, true);
      window.addEventListener('scroll', hidePill, { passive: true });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) close();
      });

      (document.body || document.documentElement).appendChild(host);
      applyTheme();
    }

    function applyTheme() {
      if (!root) return;
      root.querySelector('.pill').classList.toggle('dark', cfg.dark);
      root.querySelector('.panel').classList.toggle('dark', cfg.dark);
    }

    function showPill(x, y) {
      mount();
      const pill = root.querySelector('.pill');
      pill.classList.add('show');
      const w = pill.offsetWidth || 80;
      const h = pill.offsetHeight || 30;
      pill.style.left = `${Math.max(8, Math.min(x + 10, window.innerWidth - w - 8))}px`;
      pill.style.top = `${Math.max(8, Math.min(y + 16, window.innerHeight - h - 8))}px`;
      clearTimeout(pillTimer);
      pillTimer = setTimeout(hidePill, 8000);
    }

    function hidePill(e) {
      if (!root) return;
      if (e && e.type === 'mousedown' && e.composedPath().includes(root.querySelector('.pill'))) return;
      root.querySelector('.pill').classList.remove('show');
    }

    const isOpen = () => !!root && root.querySelector('.panel').classList.contains('open');

    function open() {
      mount();
      root.querySelector('.panel').classList.add('open');
      pageLayout.set(true);
      setTimeout(() => root.querySelector('textarea').focus(), 60);
    }

    function close() {
      if (!root) return;
      root.querySelector('.panel').classList.remove('open');
      pageLayout.set(false);
    }

    function messageHtml(m) {
      if (m.role === 'user') return `<div class="msg user">${escapeHtml(m.text)}</div>`;
      let html = m.text ? markdown(m.text) : m.pending ? '<span class="thinking">思考中</span>' : '';
      if (m.error) {
        html += `<div class="error">${escapeHtml(m.error)}${m.needsKey ? '<br>点浏览器工具栏里的插件图标，在「AI 陪读」里填写 API Key。' : ''}</div>`;
      }
      return `<div class="msg assistant">${html}</div>`;
    }

    function renderConversation() {
      mount();
      const body = root.querySelector('.body');
      const busy = !!port;
      let html = '';
      if (!convo) {
        html = `<p class="empty">在书里<b>拖选一段文字</b>，点旁边的「✦ 问 AI」就能针对它提问；也可以直接在下面输入，问当前这一页的内容。</p>`;
      } else {
        if (convo.quote) html += `<blockquote class="quote">${escapeHtml(convo.quote)}</blockquote>`;
        else if (convo.page) html += `<p class="context-note">针对当前屏幕上的内容提问（约 ${convo.page.length} 字）</p>`;
        else html += `<p class="context-note">没有读取到当前页的文字，可以直接提问。</p>`;
        if (!convo.display.length) {
          const actions = convo.quote ? SELECTION_ACTIONS : PAGE_ACTIONS;
          html += `<div class="chips">${actions
            .map((a) => `<button type="button" class="chip" data-prompt="${escapeHtml(a.prompt)}"${busy ? ' disabled' : ''}>${a.label}</button>`)
            .join('')}</div>`;
        }
        html += convo.display.map(messageHtml).join('');
      }
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
      const send = root.querySelector('.send');
      send.textContent = busy ? '停止' : '发送';
      send.classList.toggle('stop', busy);
    }

    // 流式输出时按帧合并刷新
    function updateAnswer() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        const body = root.querySelector('.body');
        const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        const last = convo.display[convo.display.length - 1];
        const nodes = body.querySelectorAll('.msg.assistant');
        const node = nodes[nodes.length - 1];
        if (node && last) node.outerHTML = messageHtml(last);
        if (nearBottom) body.scrollTop = body.scrollHeight;
      });
    }

    function toggle() {
      if (isOpen()) return close();
      if (!convo) startConversation(null);
      else renderConversation();
      open();
    }

    return { showPill, hidePill, renderConversation, updateAnswer, toggle, applyTheme, close };
  })();

  // ---- 设置 / 消息 ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'wrs:toggleAiPanel') {
      ui.toggle();
      sendResponse({ ok: true });
    }
  });

  function luminance(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  globalThis.WRSAi = {
    update(s) {
      cfg.enabled = s.enabled;
      cfg.aiSelectButton = s.aiSelectButton;
      cfg.dark = s.enabled && luminance(s.bgColor) < 0.4;
      ui.applyTheme();
      if (!s.enabled || !s.aiSelectButton) ui.hidePill();
    },
  };
})();
