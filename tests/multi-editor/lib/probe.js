// Injected into every page before the app's own scripts (Page.addScriptToEvaluateOnNewDocument).
// Reports to the mock: console errors and warnings, uncaught errors, save-pill changes and canvas title
// changes, so a failed run can be read as a timeline next to the mock's request events. It never
// touches app state.
(() => {
  const who = new URLSearchParams(location.search).get('who') || '?';
  const send = (kind, detail) => {
    try {
      navigator.sendBeacon(
        '/api/__probe',
        new Blob([JSON.stringify({ who, kind, detail, t: Date.now() })], {
          type: 'application/json',
        }),
      );
    } catch {
      // The beacon is best effort: a page that is unloading has nowhere to report to.
    }
  };

  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      send('console.' + level, args.map(String).join(' ').slice(0, 400));
      original(...args);
    };
  }
  const originalLog = console.log.bind(console);
  console.log = (...args) => {
    const text = String(args[0]);
    if (/conflict|merge|Chart|sync/i.test(text))
      send('console.log', args.map(String).join(' ').slice(0, 300));
    originalLog(...args);
  };
  window.addEventListener('error', (e) => send('uncaught', String(e.message)));
  window.addEventListener('unhandledrejection', (e) =>
    send('unhandledrejection', String(e.reason)),
  );

  const snap = () => {
    const pill = document.querySelector('[role=status][data-state]');
    const titles = {};
    document.querySelectorAll('[data-tocb-node]').forEach((n) => {
      titles[n.dataset.tocbNode] = (n.innerText || '').split('\n')[0].trim();
    });
    return { pill: pill ? pill.dataset.state : null, titles };
  };
  window.__snap = snap;

  // The app's chart document, found through the React tree (the canvas receives it as its `store`
  // prop). This reads app state without changing the app: scenarios compare it with the server.
  window.__doc = () => {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return null;
    const stack = [root[key]];
    while (stack.length) {
      const fiber = stack.pop();
      const store = fiber.memoizedProps && fiber.memoizedProps.store;
      if (
        store &&
        typeof store.getCommitted === 'function' &&
        typeof store.getStatus === 'function'
      )
        return store;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  };

  let lastPill = null;
  let lastTitles = null;
  setInterval(() => {
    const s = snap();
    if (s.pill !== lastPill) {
      send('pill', { from: lastPill, to: s.pill });
      lastPill = s.pill;
    }
    const json = JSON.stringify(s.titles);
    if (json !== lastTitles) {
      if (lastTitles) {
        const prev = JSON.parse(lastTitles);
        const diff = {};
        for (const k of new Set([...Object.keys(prev), ...Object.keys(s.titles)])) {
          if (prev[k] !== s.titles[k]) diff[k] = [prev[k] ?? null, s.titles[k] ?? null];
        }
        send('canvas', diff);
      }
      lastTitles = json;
    }
  }, 25);
})();
