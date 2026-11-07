// One browser: a Chrome that `agent-browser` launches for a named session, driven over the DevTools
// protocol. agent-browser starts, names and closes the browser; the protocol connection (its
// `get cdp-url`) is used for what the scenarios need exact control of: pointer and key events with
// precise timing, IME composition, and in-page scripts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = fs.readFileSync(path.join(here, 'probe.js'), 'utf8');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentBrowser = (session, ...args) =>
  execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });

// Keys the scenarios press. `text` makes a key insert a character.
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  End: { key: 'End', code: 'End', vk: 35 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  z: { key: 'z', code: 'KeyZ', vk: 90 },
};
const MODIFIERS = { Control: 2, Shift: 8 };

const VIEWPORT = { width: 1500, height: 950 };

// A call the browser does not answer within this long has failed: under memory pressure a tab can be
// swapped out or replaced, and a call on a gone tab is never answered.
const CALL_TIMEOUT_MS = 60_000;

export class Browser {
  /** Starts the session's Chrome, attaches, and opens `url`. `shots` is where screenshots go. */
  static async open({ url, ...options }) {
    const browser = new Browser(options);
    await browser.attach();
    await browser.goto(url);
    return browser;
  }

  constructor({ session, shots }) {
    this.session = session;
    this.shots = shots;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.pointer = { x: 0, y: 0, buttons: 0 };
  }

  /**
   * Launches (or reuses) the session's Chrome through agent-browser, connects to its active tab, and
   * installs the probe and the app's first-visit answers for every page the tab loads from now on.
   */
  async attach() {
    agentBrowser(this.session, 'open', 'about:blank');
    const cdpUrl = agentBrowser(this.session, 'get', 'cdp-url')
      .split('\n')
      .find((line) => line.startsWith('ws://'));
    const tabs = JSON.parse(agentBrowser(this.session, 'tab', 'list', '--json'));
    const target = tabs.data.tabs.find((tab) => tab.active && tab.type === 'page').targetId;
    const ws = new WebSocket(cdpUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    this.ws = ws;
    this.pointer = { x: 0, y: 0, buttons: 0 };
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject, method, timer } = this.pending.get(data.id);
        clearTimeout(timer);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${method}: ${JSON.stringify(data.error)}`));
        else resolve(data.result);
      } else if (
        data.method === 'Target.detachedFromTarget' ||
        data.method === 'Inspector.detached'
      ) {
        this.failPending('the tab was closed or replaced');
      } else if (data.method) {
        for (const listener of this.listeners) listener(data);
      }
    };
    ws.onclose = () => this.failPending('the DevTools connection closed');
    const { sessionId } = await this.root('Target.attachToTarget', {
      targetId: target,
      flatten: true,
    });
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Network.enable');
    // Analytics and web fonts are third-party and not under test; a blocked request fails at once.
    await this.send('Network.setBlockedURLs', {
      urls: ['*simpleanalyticscdn*', '*fonts.googleapis.com*', '*fonts.gstatic.com*'],
    });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "localStorage.setItem('privacyPolicyAccepted','true');" +
        "localStorage.setItem('usageLoggingOptOut','true');" +
        PROBE,
    });
  }

  failPending(reason) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Whether the tab answers; if not, replaces the browser. Call before a run that needs it. */
  async ensureAlive() {
    try {
      await this.call('Runtime.evaluate', { expression: '1' }, this.sessionId, 15_000);
    } catch (error) {
      console.error(`${this.session} did not answer (${error.message}); reopening`);
      await this.reopen();
    }
  }

  /** Throws the browser away and starts a fresh one in the same session. */
  async reopen() {
    this.failPending('the browser was reopened');
    try {
      this.ws.close();
    } catch {
      // The connection is already closed, which is the state wanted.
    }
    try {
      agentBrowser(this.session, 'close');
    } catch (error) {
      // A browser that is already gone has nothing left to close.
      console.error(`close ${this.session}: ${String(error.message).split('\n')[0]}`);
    }
    await sleep(1000);
    await this.attach();
  }

  root(method, params = {}) {
    return this.call(method, params, undefined);
  }

  send(method, params = {}) {
    return this.call(method, params, this.sessionId);
  }

  call(method, params, sessionId, timeout = CALL_TIMEOUT_MS) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }

  async goto(url) {
    let listener;
    let timer;
    const loaded = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${url} did not finish loading`)), 90_000);
      listener = (event) => {
        if (event.method === 'Page.loadEventFired') resolve();
      };
      this.on(listener);
    });
    try {
      await this.send('Page.navigate', { url });
      await loaded;
    } finally {
      clearTimeout(timer);
      this.listeners = this.listeners.filter((l) => l !== listener);
      // A navigation that failed leaves `loaded` pending or rejected with nobody to hear it.
      loaded.catch(() => {});
    }
  }

  /** Evaluates an expression in the page and returns its JSON value. Throws on a page exception. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(
        `page exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n${expression.slice(0, 300)}`,
      );
    }
    return result.value;
  }

  /** Polls `expression` in the page until it is truthy; false if it is not within `timeout`. */
  async until(expression, { timeout = 20_000, every = 50 } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (await this.eval(`Boolean(${expression})`)) return true;
      if (Date.now() - t0 > timeout) return false;
      await sleep(every);
    }
  }

  /** Like `until`, but a timeout is an error: the scenario cannot go on without it. */
  async waitFor(expression, { what = expression, ...options } = {}) {
    if (!(await this.until(expression, options))) {
      throw new Error(`timed out after ${options.timeout ?? 20_000} ms waiting for ${what}`);
    }
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(this.shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  // Pointer. The page sees pointer events as for a real mouse.

  async mouse(type, x = this.pointer.x, y = this.pointer.y) {
    const button = type === 'mouseMoved' ? (this.pointer.buttons ? 'left' : 'none') : 'left';
    if (type === 'mousePressed') this.pointer.buttons = 1;
    if (type === 'mouseReleased') this.pointer.buttons = 0;
    this.pointer.x = x;
    this.pointer.y = y;
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: this.pointer.buttons,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  move(x, y) {
    return this.mouse('mouseMoved', Math.round(x), Math.round(y));
  }

  down() {
    return this.mouse('mousePressed');
  }

  up() {
    return this.mouse('mouseReleased');
  }

  /** Moves the pointer to (x, y) in `steps` events spread over `ms`. */
  async glide(x, y, { steps = 8, ms = 0 } = {}) {
    const { x: x0, y: y0 } = this.pointer;
    for (let i = 1; i <= steps; i++) {
      await this.move(x0 + ((x - x0) * i) / steps, y0 + ((y - y0) * i) / steps);
      if (ms) await sleep(ms / steps);
    }
  }

  async click(x, y) {
    await this.move(x, y);
    await this.down();
    await this.up();
  }

  // Keyboard.

  async press(combo) {
    const parts = combo.split('+');
    const name = parts.pop();
    const def = KEYS[name] ?? {
      key: name,
      code: `Key${name.toUpperCase()}`,
      vk: name.toUpperCase().charCodeAt(0),
    };
    const modifiers = parts.reduce((sum, m) => sum | MODIFIERS[m], 0);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers,
      text: modifiers ? undefined : def.text,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers,
    });
  }

  /** Types `text` as keystrokes, `gapMs` between keys. */
  async type(text, gapMs = 0) {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
      if (gapMs) await sleep(gapMs);
    }
  }

  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  /** An IME's in-progress composition: the text is shown underlined and not yet committed. */
  imeCompose(text) {
    return this.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }

  /** Puts files in a file input as the picker would. */
  async chooseFiles(selector, files) {
    const { root } = await this.send('DOM.getDocument');
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matches ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, nodeId });
  }

  async close() {
    this.ws.close();
    try {
      agentBrowser(this.session, 'close');
    } catch (error) {
      // A browser that is already gone has nothing left to close.
      console.error(`close ${this.session}: ${String(error.message).split('\n')[0]}`);
    }
  }
}
