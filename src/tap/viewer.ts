/** 本地 Tap Viewer 的自包含页面，不依赖前端框架或外部资源。 */
export const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DKAgent Tap</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, monospace; }
    body { margin: 0; background: #0b0d10; color: #e7e9ee; }
    header { height: 48px; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid #252a33; }
    #status { margin-left: 12px; color: #9ba3b4; font-size: 12px; }
    main { display: grid; grid-template-columns: 240px minmax(320px, 1fr) minmax(360px, 1fr); height: calc(100vh - 49px); }
    section { overflow: auto; border-right: 1px solid #252a33; padding: 12px; }
    button, article { width: 100%; box-sizing: border-box; text-align: left; color: inherit; background: #141820; border: 1px solid #252a33; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
    .active { border-color: #66d9a8; }
    .removed { border-color: #ff6b6b; background: #2a1518; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
    @media (max-width: 900px) { main { grid-template-columns: 180px 1fr; } #detail { grid-column: 1 / -1; } }
  </style>
</head>
<body>
  <header><strong>DKAgent Tap</strong><span id="status">连接中</span></header>
  <main><section id="turns"></section><section id="flow"></section><section id="detail"><div id="diff"></div><pre id="json"></pre></section></main>
  <script>
    const state = { events: [], activeTurnId: null, selectedId: null };
    const stable = (value) => JSON.stringify(value);
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const summary = (event) => {
      if (event.type === 'turn.start') return event.payload.input;
      if (event.type === 'tool.call') return event.payload.name;
      if (event.type === 'tool.result') return event.payload.name;
      if (event.type === 'turn.end') return event.payload.answer;
      if (event.type === 'context.after') return event.payload.estimatedInputTokens + ' / ' + event.payload.availableInputTokens + ' tokens';
      return event.type;
    };
    const contextPair = (event) => {
      if (event.type !== 'context.after') return null;
      const before = state.events.find((item) => item.type === 'context.before' && item.turnId === event.turnId && item.step === event.step);
      return before ? { before: before.payload.messages, after: event.payload.messages } : null;
    };
    const removedMessages = (pair) => {
      if (!pair) return [];
      const remaining = new Map();
      for (const message of pair.after) {
        const key = stable(message);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
      }
      return pair.before.filter((message) => {
        const key = stable(message);
        const count = remaining.get(key) ?? 0;
        if (count === 0) return true;
        remaining.set(key, count - 1);
        return false;
      });
    };
    function render() {
      const turns = [...new Set(state.events.map((event) => event.turnId))];
      state.activeTurnId ??= turns.at(-1) ?? null;
      document.querySelector('#turns').innerHTML = turns.map((id, index) => '<button class="' + (id === state.activeTurnId ? 'active' : '') + '" data-turn="' + escapeHtml(id) + '">第 ' + (index + 1) + ' 轮</button>').join('');
      const visible = state.events.filter((event) => event.turnId === state.activeTurnId);
      document.querySelector('#flow').innerHTML = visible.map((event) => '<article data-id="' + escapeHtml(event.id) + '"><strong>' + escapeHtml(event.type) + '</strong><small> step ' + (event.step ?? '-') + '</small><p>' + escapeHtml(summary(event)) + '</p></article>').join('');
      const selected = state.events.find((event) => event.id === state.selectedId) ?? visible.at(-1);
      if (!selected) {
        document.querySelector('#diff').innerHTML = '';
        document.querySelector('#json').textContent = '';
        return;
      }
      const pair = contextPair(selected);
      const removed = removedMessages(pair);
      document.querySelector('#diff').innerHTML = removed.length ? '<h3>压缩移除</h3>' + removed.map((message) => '<article class="removed"><pre>' + escapeHtml(JSON.stringify(message, null, 2)) + '</pre></article>').join('') : '';
      document.querySelector('#json').textContent = JSON.stringify({ event: selected, contextDiff: pair ? { ...pair, removed } : null }, null, 2);
    }
    document.addEventListener('click', (event) => {
      const turnId = event.target.closest('[data-turn]')?.dataset.turn;
      const eventId = event.target.closest('[data-id]')?.dataset.id;
      if (turnId) { state.activeTurnId = turnId; state.selectedId = null; render(); }
      if (eventId) { state.selectedId = eventId; render(); }
    });
    fetch('/api/events').then((response) => response.json()).then((events) => { state.events = events; render(); }).catch(() => {
      document.querySelector('#status').textContent = '读取失败';
    });
    const stream = new EventSource('/api/events/stream');
    stream.onopen = () => document.querySelector('#status').textContent = '实时连接';
    stream.onmessage = (message) => { state.events.push(JSON.parse(message.data)); render(); };
    stream.onerror = () => document.querySelector('#status').textContent = '重连中';
  </script>
</body>
</html>`;
