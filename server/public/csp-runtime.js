/* ERP Taranom CSP runtime: delegated events, contextual HTML sanitization and Trusted Types. */
(function initCspRuntime(global) {
  'use strict';

  if (global.CSP) return;

  const ACTION_ATTR_PREFIX = 'data-csp-';
  const EVENT_TYPES = Object.freeze([
    'click', 'change', 'input', 'focus', 'blur', 'keydown', 'mousedown',
    'error', 'dragstart', 'dragover', 'dragleave', 'drop'
  ]);
  const CAPTURE_EVENTS = new Set(['focus', 'blur', 'error']);
  const actions = new Map();
  const styles = new Map();
  let actionSequence = 0;

  function actionId() {
    const random = new Uint32Array(2);
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(random);
    } else {
      random[0] = Date.now() >>> 0;
      random[1] = actionSequence >>> 0;
    }
    actionSequence += 1;
    return `a_${random[0].toString(36)}${random[1].toString(36)}_${actionSequence.toString(36)}`;
  }

  function assertEventType(type) {
    const normalized = String(type || '').toLowerCase();
    if (!EVENT_TYPES.includes(normalized)) throw new TypeError(`Unsupported delegated event: ${normalized}`);
    return normalized;
  }

  function bind(type, handler) {
    const normalized = assertEventType(type);
    if (typeof handler !== 'function') throw new TypeError('CSP.bind requires a function');
    const id = actionId();
    actions.set(id, { type: normalized, handler });
    return id;
  }

  function register(id, type, handler) {
    const safeId = String(id || '');
    const normalized = assertEventType(type);
    if (!/^s_[a-f0-9]{16,64}$/i.test(safeId)) throw new TypeError('Invalid static CSP action id');
    if (typeof handler !== 'function') throw new TypeError('CSP.register requires a function');
    const previous = actions.get(safeId);
    if (previous && (previous.type !== normalized || previous.handler !== handler)) {
      throw new Error(`Duplicate CSP action id: ${safeId}`);
    }
    actions.set(safeId, { type: normalized, handler });
    return safeId;
  }

  function bindElement(element, type, handler) {
    if (!(element instanceof Element)) throw new TypeError('CSP.bindElement requires an Element');
    const normalized = assertEventType(type);
    const id = bind(normalized, handler);
    element.setAttribute(`${ACTION_ATTR_PREFIX}${normalized}`, id);
    return id;
  }

  function parseStyle(cssText) {
    const source = String(cssText == null ? '' : cssText).trim();
    if (!source) return [];
    if (/(?:url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@import|-moz-binding|\bbehavior\s*:)/i.test(source)) {
      throw new TypeError('Unsafe inline style value');
    }
    const scratch = document.createElement('div');
    scratch.style.cssText = source;
    const declarations = [];
    for (const property of scratch.style) {
      if (!/^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/i.test(property)) continue;
      const value = scratch.style.getPropertyValue(property);
      if (/(?:url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@import|-moz-binding)/i.test(value)) continue;
      declarations.push([property, value, scratch.style.getPropertyPriority(property)]);
    }
    return declarations;
  }

  function styleId(declarations, prefix) {
    const canonical = JSON.stringify(declarations);
    let hash = 2166136261;
    for (let i = 0; i < canonical.length; i++) {
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    actionSequence += 1;
    return `${prefix}_${(hash >>> 0).toString(36)}_${actionSequence.toString(36)}`;
  }

  function style(cssText) {
    const declarations = parseStyle(cssText);
    const id = styleId(declarations, 'd');
    styles.set(id, declarations);
    return id;
  }

  function applyRegisteredStyle(element) {
    if (!(element instanceof Element)) return;
    const id = element.getAttribute('data-csp-style');
    if (!id) return;
    const declarations = styles.get(id);
    if (!declarations) return;
    for (const [property, value, priority] of declarations) element.style.setProperty(property, value, priority);
    element.removeAttribute('data-csp-style');
    if (id.startsWith('d_')) styles.delete(id);
  }

  function scanRegisteredStyles(root) {
    if (root instanceof Element) applyRegisteredStyle(root);
    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('[data-csp-style]').forEach(applyRegisteredStyle);
    }
  }

  function registerStyle(id, cssText) {
    const safeId = String(id || '');
    if (!/^s_[a-f0-9]{16,64}$/i.test(safeId)) throw new TypeError('Invalid static CSP style id');
    styles.set(safeId, parseStyle(cssText));
    scanRegisteredStyles(document);
    return safeId;
  }

  function resolve(candidate) {
    if (typeof candidate === 'function') return candidate;
    const name = String(candidate || '');
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)) {
      throw new TypeError('Invalid action function name');
    }
    const parts = name.split('.');
    let value = global;
    for (const part of parts) value = value && value[part];
    if (typeof value !== 'function') throw new TypeError(`Unknown action function: ${name}`);
    return value;
  }

  function htmlDecode(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value == null ? '' : value);
    return textarea.value;
  }

  function dispatch(event) {
    const attr = `${ACTION_ATTR_PREFIX}${event.type}`;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const elements = path.length
      ? path.filter(node => node instanceof Element)
      : (() => {
          const result = [];
          for (let node = event.target; node instanceof Element; node = node.parentElement) result.push(node);
          return result;
        })();

    for (const element of elements) {
      const id = element.getAttribute(attr);
      if (!id) continue;
      const action = actions.get(id);
      if (!action || action.type !== event.type) continue;
      let result;
      try {
        result = action.handler.call(element, event);
      } catch (error) {
        console.error('Delegated UI action failed', { type: event.type, id, error });
        global.dispatchEvent(new CustomEvent('csp-action-error', { detail: { type: event.type, id } }));
        return;
      }
      if (result === false) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.cancelBubble) return;
    }
  }

  for (const type of EVENT_TYPES) document.addEventListener(type, dispatch, CAPTURE_EVENTS.has(type));

  const nativeInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const nativeOuterHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
  const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  const blockedElements = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META']);
  const urlAttributes = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);
  const parserPolicy = global.trustedTypes
    ? global.trustedTypes.createPolicy('erp-sanitizer-parser', { createHTML: value => String(value) })
    : { createHTML: value => String(value) };

  function safeUrl(raw, element, attribute) {
    const value = String(raw || '').trim();
    if (!value) return true;
    if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
    if (/^blob:/i.test(value)) return true;
    if (/^data:image\/(?:png|gif|jpe?g|webp);/i.test(value) && element.tagName === 'IMG' && attribute === 'src') return true;
    try {
      const parsed = new URL(value, document.baseURI);
      if (element.tagName === 'A' && attribute === 'href') return parsed.protocol === 'https:' || parsed.origin === location.origin;
      return parsed.origin === location.origin
        || (parsed.protocol === 'http:' && /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i.test(parsed.hostname));
    } catch (_) {
      return false;
    }
  }

  function sanitizeRoot(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const remove = [];
    for (let element = walker.nextNode(); element; element = walker.nextNode()) {
      const tagName = String(element.localName || element.tagName || '').toUpperCase();
      if (blockedElements.has(tagName)) {
        remove.push(element);
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (name.startsWith(ACTION_ATTR_PREFIX)) {
          if (name === 'data-csp-style') {
            if (!styles.has(attribute.value)) element.removeAttribute(attribute.name);
            continue;
          }
          const type = name.slice(ACTION_ATTR_PREFIX.length);
          const action = actions.get(attribute.value);
          if (!EVENT_TYPES.includes(type) || !action || action.type !== type) element.removeAttribute(attribute.name);
          continue;
        }
        if (urlAttributes.has(name) && !safeUrl(attribute.value, element, name)) element.removeAttribute(attribute.name);
      }
      if (tagName === 'A' && element.getAttribute('target') === '_blank') {
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    for (const element of remove) element.remove();
    return root;
  }

  function sanitizeToString(value) {
    const template = document.createElement('template');
    nativeInnerHTML.set.call(template, parserPolicy.createHTML(String(value == null ? '' : value)));
    sanitizeRoot(template.content);
    return nativeInnerHTML.get.call(template);
  }

  function openBlobDocument(serialized) {
    const objectUrl = URL.createObjectURL(new Blob([serialized], { type: 'text/html;charset=utf-8' }));
    const opened = global.open(objectUrl, '_blank');
    if (!opened) {
      URL.revokeObjectURL(objectUrl);
      return false;
    }
    try { opened.opener = null; } catch (_) { /* cross-origin window handles may reject this */ }
    global.setTimeout(() => URL.revokeObjectURL(objectUrl), 300000);
    return true;
  }

  function openDocument(value, baseUrl) {
    const parsed = new DOMParser().parseFromString(
      parserPolicy.createHTML(String(value == null ? '' : value)),
      'text/html'
    );
    sanitizeRoot(parsed);
    parsed.querySelectorAll('base,meta[http-equiv="Content-Security-Policy" i]').forEach(node => node.remove());
    const base = parsed.createElement('base');
    const safeBase = new URL('/', baseUrl || location.origin);
    if (safeBase.origin !== location.origin) throw new TypeError('Print document base must be same-origin');
    base.href = safeBase.href;
    parsed.head.prepend(base);
    const policy = parsed.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'";
    parsed.head.prepend(policy);
    const serialized = `<!doctype html>\n${nativeOuterHTML.get.call(parsed.documentElement)}`;
    return openBlobDocument(serialized);
  }

  function parsePolicy(value) {
    const directives = new Map();
    for (const rawDirective of String(value || '').split(';')) {
      const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const name = parts.shift().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(name) || directives.has(name)) {
        throw new TypeError('Invalid or duplicate verified-document CSP directive');
      }
      directives.set(name, parts);
    }
    return directives;
  }

  function canonicalPolicy(value) {
    return String(value || '')
      .split(';')
      .map(part => part.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join('; ');
  }

  function assertNoneDirective(directives, name) {
    const values = directives.get(name) || [];
    if (values.length !== 1 || values[0].toLowerCase() !== "'none'") {
      throw new TypeError(`Verified document CSP requires ${name} 'none'`);
    }
  }

  function assertVerifiedPolicy(policy) {
    const source = canonicalPolicy(policy);
    if (!source || /'(?:unsafe-inline|unsafe-eval|wasm-unsafe-eval)'/i.test(source)) {
      throw new TypeError('Verified document CSP contains an unsafe script or style capability');
    }
    const directives = parsePolicy(source);
    const requiredDirectives = new Set([
      'default-src', 'script-src', 'script-src-attr', 'style-src', 'style-src-attr',
      'img-src', 'font-src', 'connect-src', 'object-src', 'base-uri', 'form-action',
      'frame-ancestors', 'sandbox'
    ]);
    if (directives.size !== requiredDirectives.size || [...directives.keys()].some(name => !requiredDirectives.has(name))) {
      throw new TypeError('Verified document CSP has missing or unapproved directives');
    }
    for (const name of ['default-src', 'script-src-attr', 'style-src-attr', 'connect-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      assertNoneDirective(directives, name);
    }
    const scriptSources = directives.get('script-src');
    if (!scriptSources || scriptSources.length !== 1 || !["'none'", "'self'"].includes(scriptSources[0].toLowerCase())) {
      throw new TypeError('Verified document CSP has an untrusted script source');
    }
    const allowPrintScript = scriptSources[0].toLowerCase() === "'self'";
    const styleSources = directives.get('style-src') || [];
    const nonceMatch = styleSources.length === 2 && /^'nonce-([a-z0-9+/_-]{16,}={0,2})'$/i.exec(styleSources[1]);
    if (styleSources[0]?.toLowerCase() !== "'self'" || !nonceMatch) {
      throw new TypeError('Verified document CSP has an untrusted style source');
    }
    const imgSources = directives.get('img-src') || [];
    if (imgSources.length !== 2 || imgSources[0].toLowerCase() !== "'self'" || imgSources[1].toLowerCase() !== 'data:') {
      throw new TypeError('Verified document CSP has an untrusted image source');
    }
    const fontSources = directives.get('font-src') || [];
    if (fontSources.length !== 1 || fontSources[0].toLowerCase() !== "'self'") {
      throw new TypeError('Verified document CSP has an untrusted font source');
    }
    const sandbox = (directives.get('sandbox') || []).map(value => value.toLowerCase());
    const expectedSandbox = allowPrintScript
      ? ['allow-same-origin', 'allow-scripts', 'allow-modals']
      : ['allow-same-origin'];
    if (sandbox.length !== expectedSandbox.length || sandbox.some((value, index) => value !== expectedSandbox[index])) {
      throw new TypeError('Verified document CSP has an invalid sandbox capability set');
    }
    return Object.freeze({ source, allowPrintScript, styleNonce: nonceMatch[1] });
  }

  function removeAndVerifyStyleElements(html, expectedNonce) {
    let styleCount = 0;
    const withoutStyles = String(html).replace(/<style\b([^>]*)>[\s\S]*?<\/style\s*>/gi, (_whole, attributes) => {
      styleCount += 1;
      if (/\son[a-z0-9_-]+\s*=|\sstyle\s*=|\ssrcdoc\s*=/i.test(attributes)) {
        throw new TypeError('Verified document style element has forbidden attributes');
      }
      const nonces = [...String(attributes).matchAll(/\bnonce\s*=\s*(["'])(.*?)\1/gi)];
      if (nonces.length !== 1 || nonces[0][2] !== expectedNonce) {
        throw new TypeError('Verified document style nonce does not match its CSP');
      }
      return '';
    });
    const openingCount = (String(html).match(/<style\b/gi) || []).length;
    const closingCount = (String(html).match(/<\/style\s*>/gi) || []).length;
    if (styleCount !== openingCount || styleCount !== closingCount) {
      throw new TypeError('Verified document contains malformed style markup');
    }
    return withoutStyles;
  }

  function assertVerifiedMarkup(parsed, responseUrl, verifiedPolicy) {
    if (parsed.querySelector('base,meta[http-equiv]:not([http-equiv="Content-Security-Policy" i])')) {
      throw new TypeError('Verified document contains a forbidden base or HTTP-equivalent meta element');
    }
    for (const element of parsed.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          throw new TypeError('Verified document contains executable inline markup');
        }
        if (urlAttributes.has(name) && /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/i.test(attribute.value)) {
          throw new TypeError('Verified document contains an unsafe URL');
        }
      }
    }
    if (!verifiedPolicy.allowPrintScript && parsed.scripts.length) {
      throw new TypeError('Verified document script does not match its CSP');
    }
    for (const script of parsed.scripts) {
      if (script.textContent.trim() || !script.getAttribute('src')) {
        throw new TypeError('Verified document contains an inline script');
      }
      const source = new URL(script.getAttribute('src'), responseUrl);
      if (source.origin !== location.origin || !/^https?:$/.test(source.protocol)
          || source.pathname !== '/print-page.js' || source.search || source.hash) {
        throw new TypeError('Verified document contains a non-approved script');
      }
    }
  }

  function sanitizeScriptUrl(value) {
    const parsed = new URL(String(value || ''), location.origin);
    const allowed = new Set(['/sw.js', '/vendor/chart.umd.js']);
    if (parsed.origin !== location.origin || !/^https?:$/.test(parsed.protocol) || !allowed.has(parsed.pathname)) {
      throw new TypeError('Untrusted script URL');
    }
    return parsed.pathname + parsed.search;
  }

  async function readVerifiedServerDocument(response) {
    if (!response || typeof response.text !== 'function' || !response.headers || response.bodyUsed) {
      throw new TypeError('A fresh fetch Response is required');
    }
    const responseUrl = new URL(String(response.url || ''));
    if (responseUrl.origin !== location.origin || !/^https?:$/.test(responseUrl.protocol)) {
      throw new TypeError('Verified document response must be same-origin');
    }
    if (!response.ok || response.headers.get('X-Taranom-Safe-HTML') !== '1') {
      throw new TypeError('Server did not attest this HTML document');
    }
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'text/html') throw new TypeError('Verified document must be HTML');
    const policy = assertVerifiedPolicy(response.headers.get('Content-Security-Policy'));
    const declaredLength = Number(response.headers.get('Content-Length') || 0);
    if (declaredLength > 10 * 1024 * 1024) throw new TypeError('Verified document is too large');

    const html = await response.text();
    if (html.length > 10 * 1024 * 1024) throw new TypeError('Verified document is too large');
    const inspectionHtml = removeAndVerifyStyleElements(html, policy.styleNonce);
    const parsed = new DOMParser().parseFromString(parserPolicy.createHTML(inspectionHtml), 'text/html');
    const policyMeta = parsed.head && parsed.head.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]');
    if (!policyMeta || policyMeta.length !== 1 || canonicalPolicy(policyMeta[0].content) !== policy.source) {
      throw new TypeError('Verified document CSP header/meta mismatch');
    }
    assertVerifiedMarkup(parsed, responseUrl.href, policy);
    return Object.freeze({ html, policy });
  }

  async function openVerifiedServerDocument(response) {
    const verified = await readVerifiedServerDocument(response);
    return openBlobDocument(verified.html);
  }

  async function createVerifiedServerFrame(response, options) {
    const verified = await readVerifiedServerDocument(response);
    const objectUrl = URL.createObjectURL(new Blob([verified.html], { type: 'text/html;charset=utf-8' }));
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.sandbox.add('allow-same-origin');
    iframe.style.position = 'fixed';
    iframe.style.insetInlineStart = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = `${Math.max(320, Math.min(2400, Number(options?.width) || 800))}px`;
    iframe.style.height = `${Math.max(320, Math.min(4000, Number(options?.height) || 1100))}px`;
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.src = objectUrl;
    document.body.appendChild(iframe);
    try {
      await new Promise((resolve, reject) => {
        const timer = global.setTimeout(() => reject(new Error('Verified document frame timed out')), 10000);
        iframe.addEventListener('load', () => { global.clearTimeout(timer); resolve(); }, { once: true });
        iframe.addEventListener('error', () => { global.clearTimeout(timer); reject(new Error('Verified document frame failed')); }, { once: true });
      });
      if (!iframe.contentDocument || !iframe.contentDocument.body) throw new Error('Verified document frame is unavailable');
      const loadedPolicy = iframe.contentDocument.head?.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.content;
      if (canonicalPolicy(loadedPolicy) !== verified.policy.source) throw new Error('Verified document frame was blocked or replaced');
    } catch (error) {
      iframe.remove();
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    let disposed = false;
    return Object.freeze({
      element: iframe,
      dispose() {
        if (disposed) return;
        disposed = true;
        iframe.remove();
        URL.revokeObjectURL(objectUrl);
      }
    });
  }

  function installCaptureFrameWriter(iframe) {
    const frameWindow = iframe.contentWindow;
    if (!frameWindow || !frameWindow.trustedTypes || !frameWindow.Document) return;
    const documentPrototype = frameWindow.Document.prototype;
    const nativeWrite = documentPrototype.write;
    const writePolicy = frameWindow.trustedTypes.createPolicy('erp-taranom', {
      createHTML(value) {
        const skeleton = String(value || '');
        if (!/^<!DOCTYPE html><html><\/html>$/i.test(skeleton)) {
          throw new TypeError('Unexpected html2canvas document skeleton');
        }
        return skeleton;
      }
    });
    documentPrototype.write = function trustedCaptureWrite(...values) {
      return nativeWrite.call(this, writePolicy.createHTML(values.join('')));
    };
  }

  let captureQueue = Promise.resolve();
  function capture(element, options) {
    const run = async () => {
      if (!(element instanceof Element) || typeof global.html2canvas !== 'function') {
        throw new TypeError('CSP.capture requires an Element and html2canvas');
      }
      const nativeAppendChild = Node.prototype.appendChild;
      function captureAppendChild(node) {
        if (String(node?.localName || '').toLowerCase() === 'style'
            && String(node.textContent || '').includes('___html2canvas___pseudoelement_')) {
          // html2canvas injects this helper style only to suppress cloned pseudo-elements.
          // It is already blocked by style-src; omit it before insertion to avoid CSP noise.
          return node;
        }
        const appended = nativeAppendChild.call(this, node);
        if (node instanceof HTMLIFrameElement) installCaptureFrameWriter(node);
        return appended;
      }
      Node.prototype.appendChild = captureAppendChild;
      try {
        return await global.html2canvas(element, options || {});
      } finally {
        if (Node.prototype.appendChild === captureAppendChild) Node.prototype.appendChild = nativeAppendChild;
      }
    };
    const result = captureQueue.then(run, run);
    captureQueue = result.catch(() => undefined);
    return result;
  }

  const trustedPolicy = global.trustedTypes
    ? global.trustedTypes.createPolicy('erp-taranom', {
        createHTML: sanitizeToString,
        createScriptURL: sanitizeScriptUrl
      })
    : { createHTML: sanitizeToString, createScriptURL: sanitizeScriptUrl };

  function trusted(value) {
    return trustedPolicy.createHTML(String(value == null ? '' : value));
  }

  function scriptUrl(value) {
    return trustedPolicy.createScriptURL(String(value == null ? '' : value));
  }

  if (nativeInnerHTML && nativeInnerHTML.configurable) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      enumerable: nativeInnerHTML.enumerable,
      get: nativeInnerHTML.get,
      set(value) { nativeInnerHTML.set.call(this, trusted(value)); }
    });
  }
  if (nativeOuterHTML && nativeOuterHTML.configurable) {
    Object.defineProperty(Element.prototype, 'outerHTML', {
      configurable: true,
      enumerable: nativeOuterHTML.enumerable,
      get: nativeOuterHTML.get,
      set(value) { nativeOuterHTML.set.call(this, trusted(value)); }
    });
  }
  Element.prototype.insertAdjacentHTML = function safeInsertAdjacentHTML(position, value) {
    return nativeInsertAdjacentHTML.call(this, position, trusted(value));
  };

  function releaseDisconnectedActions(root) {
    if (!(root instanceof Element) || root.isConnected) return;
    const elements = [root, ...root.querySelectorAll('*')];
    for (const element of elements) {
      for (const attribute of element.attributes) {
        if (!attribute.name.startsWith(ACTION_ATTR_PREFIX) || attribute.name === 'data-csp-style') continue;
        if (attribute.value.startsWith('a_')) actions.delete(attribute.value);
      }
    }
  }

  const styleObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') applyRegisteredStyle(record.target);
      for (const node of record.addedNodes || []) scanRegisteredStyles(node);
      for (const node of record.removedNodes || []) {
        if (node instanceof Element) global.setTimeout(() => releaseDisconnectedActions(node), 0);
      }
    }
  });
  styleObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-csp-style'] });
  document.addEventListener('DOMContentLoaded', () => scanRegisteredStyles(document), { once: true });

  const api = Object.freeze({
    bind,
    bindElement,
    register,
    resolve,
    htmlDecode,
    style,
    registerStyle,
    sanitize: sanitizeToString,
    trusted,
    scriptUrl,
    openDocument,
    openVerifiedServerDocument,
    createVerifiedServerFrame,
    capture,
    events: EVENT_TYPES
  });
  Object.defineProperty(global, 'CSP', { configurable: false, enumerable: false, writable: false, value: api });
})(window);
