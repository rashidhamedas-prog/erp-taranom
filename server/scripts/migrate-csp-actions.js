'use strict';

/*
 * One-time, deterministic migration utility for legacy inline UI handlers.
 * It turns handler source into precompiled closures registered in csp-runtime.js;
 * it never emits eval/Function or executable handler strings.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ts = require(path.join(__dirname, '..', '..', 'desktop', 'node_modules', 'typescript'));

const publicDir = path.join(__dirname, '..', 'public');
const INDEX = path.join(publicDir, 'index.html');
const EVENT_PATTERN = /\son([a-z]+)\s*=\s*(["'])/gi;
const STYLE_PATTERN = /\sstyle\s*=\s*(["'])/gi;

function write(file, value) {
  fs.writeFileSync(file, value, 'utf8');
}

function externalizeIndex() {
  let html = fs.readFileSync(INDEX, 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!inlineScripts.length && /\/app\.js\?v=1/.test(html) && /\/boot\.js\?v=1/.test(html)) return;
  if (inlineScripts.length !== 3) throw new Error(`Expected 3 inline scripts in index.html, got ${inlineScripts.length}`);

  const bootSource = `${inlineScripts[0][1].trim()}\n${inlineScripts[1][1].trim()}\n`;
  const appSource = `${inlineScripts[2][1].replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`;
  write(path.join(publicDir, 'boot.js'), bootSource);
  write(path.join(publicDir, 'app.js'), appSource);

  const styleMatches = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .filter(match => match.index < inlineScripts[2].index);
  if (styleMatches.length !== 1) throw new Error(`Expected 1 document style block in index.html, got ${styleMatches.length}`);
  write(path.join(publicDir, 'app.css'), `${styleMatches[0][1].replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`);

  const replacements = [
    { start: inlineScripts[0].index, end: inlineScripts[1].index + inlineScripts[1][0].length, value: '<script src="/boot.js?v=1"></script>' },
    { start: styleMatches[0].index, end: styleMatches[0].index + styleMatches[0][0].length, value: '<link rel="stylesheet" href="/app.css?v=1">' },
    { start: inlineScripts[2].index, end: inlineScripts[2].index + inlineScripts[2][0].length, value: '<script src="/app.js?v=1"></script>' }
  ].sort((a, b) => b.start - a.start);
  for (const replacement of replacements) html = html.slice(0, replacement.start) + replacement.value + html.slice(replacement.end);
  html = html.replace(/(<head>\s*)/i, '$1<script src="/csp-runtime.js?v=1"></script>\n');
  write(INDEX, html);
}

function externalizeStandalonePage(pageName) {
  const htmlPath = path.join(publicDir, `${pageName}.html`);
  let html = fs.readFileSync(htmlPath, 'utf8');
  if (!/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i.test(html)
      && new RegExp(`/${pageName}\\.js\\?v=1`).test(html)) return;
  const styleMatches = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  if (styleMatches.length) {
    if (styleMatches.length !== 1) throw new Error(`Expected at most one style in ${pageName}.html`);
    write(path.join(publicDir, `${pageName}.css`), `${styleMatches[0][1].replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`);
    const match = styleMatches[0];
    html = html.slice(0, match.index) + `<link rel="stylesheet" href="/${pageName}.css?v=1">` + html.slice(match.index + match[0].length);
  }

  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (inlineScripts.length > 1) throw new Error(`Expected at most one script in ${pageName}.html`);
  if (inlineScripts.length) {
    const match = inlineScripts[0];
    write(path.join(publicDir, `${pageName}.js`), `${match[1].replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`);
    html = html.slice(0, match.index) + `<script src="/${pageName}.js?v=1"></script>` + html.slice(match.index + match[0].length);
  } else {
    write(path.join(publicDir, `${pageName}.js`), "'use strict';\n");
    html = html.replace(/<\/body>/i, `<script src="/${pageName}.js?v=1"></script>\n</body>`);
  }
  html = html.replace(/(<head>\s*)/i, '$1<script src="/csp-runtime.js?v=1"></script>\n');
  write(htmlPath, html);
}

function findAttributeEnd(source, start, quote) {
  let placeholderDepth = 0;
  const lexical = [];
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    const mode = lexical[lexical.length - 1];
    if (mode === 'regex') {
      if (ch === '\\') { i++; continue; }
      if (ch === '[') { lexical.push('regex-class'); continue; }
      if (ch === '/') lexical.pop();
      continue;
    }
    if (mode === 'regex-class') {
      if (ch === '\\') { i++; continue; }
      if (ch === ']') lexical.pop();
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      const end = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (ch === '\\') { i++; continue; }
      if (mode === 'template' && ch === '$' && next === '{') {
        lexical.push('expression');
        placeholderDepth++;
        i++;
        continue;
      }
      if (ch === end) lexical.pop();
      continue;
    }
    if (mode === 'line-comment') {
      if (ch === '\n') lexical.pop();
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { lexical.pop(); i++; }
      continue;
    }
    if (mode === 'expression') {
      if (ch === '/' && next === '/') { lexical.push('line-comment'); i++; continue; }
      if (ch === '/' && next === '*') { lexical.push('block-comment'); i++; continue; }
      if (ch === "'") { lexical.push('single'); continue; }
      if (ch === '"') { lexical.push('double'); continue; }
      if (ch === '`') { lexical.push('template'); continue; }
      if (ch === '/') {
        let previous = i - 1;
        while (previous >= start && /\s/.test(source[previous])) previous--;
        if (previous < start || /[({[=,:;!?&|+*%~<>-]/.test(source[previous])) {
          lexical.push('regex');
          continue;
        }
      }
      if (ch === '{') placeholderDepth++;
      if (ch === '}') {
        placeholderDepth--;
        if (placeholderDepth === 0) lexical.pop();
      }
      continue;
    }
    if (ch === '$' && next === '{') {
      lexical.push('expression');
      placeholderDepth = 1;
      i++;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === quote) return i;
  }
  throw new Error(`Unterminated ${quote} event attribute at ${start}`);
}

function extractPlaceholders(handler) {
  const values = [];
  let output = '';
  for (let i = 0; i < handler.length;) {
    if (handler[i] !== '$' || handler[i + 1] !== '{') {
      output += handler[i++];
      continue;
    }
    const start = i;
    i += 2;
    const expressionStart = i;
    let depth = 1;
    const stack = [];
    for (; i < handler.length; i++) {
      const ch = handler[i];
      const next = handler[i + 1];
      const mode = stack[stack.length - 1];
      if (mode === 'regex') {
        if (ch === '\\') { i++; continue; }
        if (ch === '[') { stack.push('regex-class'); continue; }
        if (ch === '/') stack.pop();
        continue;
      }
      if (mode === 'regex-class') {
        if (ch === '\\') { i++; continue; }
        if (ch === ']') stack.pop();
        continue;
      }
      if (mode === 'single' || mode === 'double' || mode === 'template') {
        const end = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
        if (ch === '\\') { i++; continue; }
        if (ch === end) stack.pop();
        continue;
      }
      if (mode === 'line-comment') { if (ch === '\n') stack.pop(); continue; }
      if (mode === 'block-comment') { if (ch === '*' && next === '/') { stack.pop(); i++; } continue; }
      if (ch === '/' && next === '/') { stack.push('line-comment'); i++; continue; }
      if (ch === '/' && next === '*') { stack.push('block-comment'); i++; continue; }
      if (ch === "'") { stack.push('single'); continue; }
      if (ch === '"') { stack.push('double'); continue; }
      if (ch === '`') { stack.push('template'); continue; }
      if (ch === '/') {
        let previous = i - 1;
        while (previous >= expressionStart && /\s/.test(handler[previous])) previous--;
        if (previous < expressionStart || /[({[=,:;!?&|+*%~<>-]/.test(handler[previous])) {
          stack.push('regex');
          continue;
        }
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`Unterminated interpolation in handler: ${handler.slice(start, start + 100)}`);
    const expression = handler.slice(expressionStart, i).trim();
    const marker = `__CSP_EXPR_${values.length}__`;
    values.push(expression);
    output += marker;
    i++;
  }
  return { marked: output, values };
}

function unwrapCall(expression, name) {
  const trimmed = expression.trim();
  const prefix = `${name}(`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) return null;
  return trimmed.slice(prefix.length, -1).trim();
}

function decodedExpression(expression) {
  const escaped = unwrapCall(expression, 'esc');
  return escaped == null ? expression : `CSP.htmlDecode(String(${expression}))`;
}

function valueExpression(expression) {
  const escaped = unwrapCall(expression, 'esc');
  if (escaped != null) {
    const json = unwrapCall(escaped, 'JSON.stringify');
    return json == null ? `CSP.htmlDecode(String(${expression}))` : `(${json})`;
  }
  const json = unwrapCall(expression, 'JSON.stringify');
  return json == null ? `(${expression})` : `(${json})`;
}

function stringExpression(expression) {
  return `String((${decodedExpression(expression)}) ?? '')`;
}

function stringRanges(source) {
  const ranges = [];
  for (let i = 0; i < source.length;) {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') { i++; continue; }
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === quote) break;
      i++;
    }
    if (i >= source.length) throw new Error(`Unterminated handler string: ${source}`);
    ranges.push({ start, end: i, quote });
    i++;
  }
  return ranges;
}

function compileHandler(rawHandler) {
  const { marked, values } = extractPlaceholders(rawHandler);
  let code = marked;
  const ranges = stringRanges(marked).filter(range => /__CSP_EXPR_\d+__/.test(marked.slice(range.start, range.end + 1)));
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    let content = marked.slice(range.start + 1, range.end).replace(/`/g, '\\`');
    content = content.replace(/__CSP_EXPR_(\d+)__/g, (_, index) => `\${${stringExpression(values[Number(index)])}}`);
    code = code.slice(0, range.start) + '`' + content + '`' + code.slice(range.end + 1);
  }
  code = code.replace(/__CSP_EXPR_(\d+)__(\s*)(?=\()/g, (_, index, space) => `CSP.resolve(${values[Number(index)]})${space}`);
  code = code.replace(/__CSP_EXPR_(\d+)__/g, (_, index) => valueExpression(values[Number(index)]));
  const parsed = ts.createSourceFile('handler.js', `function __handler(event){${code}\n}`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) {
    const detail = parsed.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ');
    throw new Error(`Invalid migrated handler (${detail}): ${rawHandler} => ${code}`);
  }
  return code;
}

function collectLiteralNodes(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) {
    throw new Error(`${filename} did not parse before migration: ${parsed.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  }
  const nodes = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      nodes.push({ start: node.getStart(parsed), end: node.getEnd(), node });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return nodes;
}

function findHandlerAttributes(source) {
  const results = [];
  EVENT_PATTERN.lastIndex = 0;
  for (let match; (match = EVENT_PATTERN.exec(source));) {
    const quote = match[2];
    const valueStart = EVENT_PATTERN.lastIndex;
    const valueEnd = findAttributeEnd(source, valueStart, quote);
    results.push({
      start: match.index,
      end: valueEnd + 1,
      type: match[1].toLowerCase(),
      quote,
      handler: source.slice(valueStart, valueEnd)
    });
    EVENT_PATTERN.lastIndex = valueEnd + 1;
  }
  return results;
}

function findStyleAttributes(source) {
  const results = [];
  STYLE_PATTERN.lastIndex = 0;
  for (let match; (match = STYLE_PATTERN.exec(source));) {
    const quote = match[1];
    const valueStart = STYLE_PATTERN.lastIndex;
    const valueEnd = findAttributeEnd(source, valueStart, quote);
    results.push({ start: match.index, end: valueEnd + 1, quote, css: source.slice(valueStart, valueEnd) });
    STYLE_PATTERN.lastIndex = valueEnd + 1;
  }
  return results;
}

function migrateJavascript(filename) {
  const file = path.join(publicDir, filename);
  let source = fs.readFileSync(file, 'utf8');
  const nodes = collectLiteralNodes(source, filename);
  const candidates = findHandlerAttributes(source);
  const replacements = [];
  for (const candidate of candidates) {
    const container = nodes
      .filter(node => node.start <= candidate.start && node.end >= candidate.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (!container) throw new Error(`${filename}: handler is not inside a JavaScript string at offset ${candidate.start}`);
    const code = compileHandler(candidate.handler);
    const expression = ` data-csp-${candidate.type}="\${CSP.bind('${candidate.type}',function(event){${code}})}"`;
    replacements.push({ ...candidate, value: expression, container });
  }

  const stringContainers = new Map();
  for (const replacement of replacements) {
    if (ts.isStringLiteral(replacement.container.node)) {
      const key = replacement.container.start;
      if (!stringContainers.has(key)) stringContainers.set(key, replacement.container);
    }
  }
  for (const container of stringContainers.values()) {
    const raw = source.slice(container.start, container.end);
    if (raw[0] === '`') continue;
    const inner = raw.slice(1, -1);
    if (inner.includes('`')) throw new Error(`${filename}: cannot safely convert string containing a backtick at ${container.start}`);
    replacements.push({ start: container.start, end: container.start + 1, value: '`', delimiterOnly: true });
    replacements.push({ start: container.end - 1, end: container.end, value: '`', delimiterOnly: true });
  }

  for (const replacement of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  const check = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (check.parseDiagnostics.length) {
    throw new Error(`${filename} failed after migration: ${check.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  }
  write(file, source);
  return candidates.length;
}

function migrateJavascriptStyles(filename) {
  const file = path.join(publicDir, filename);
  let source = fs.readFileSync(file, 'utf8');
  const nodes = collectLiteralNodes(source, filename);
  const candidates = findStyleAttributes(source);
  const replacements = [];
  for (const candidate of candidates) {
    const container = nodes
      .filter(node => node.start <= candidate.start && node.end >= candidate.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (!container) throw new Error(`${filename}: style is not inside a JavaScript string at offset ${candidate.start}`);
    if (candidate.css.includes('`')) throw new Error(`${filename}: backtick in style attribute at ${candidate.start}`);
    replacements.push({
      ...candidate,
      value: ` data-csp-style="\${CSP.style(\`${candidate.css}\`)}"`,
      container
    });
  }

  const stringContainers = new Map();
  for (const replacement of replacements) {
    if (ts.isStringLiteral(replacement.container.node)) stringContainers.set(replacement.container.start, replacement.container);
  }
  for (const container of stringContainers.values()) {
    const raw = source.slice(container.start, container.end);
    if (raw[0] === '`') continue;
    if (raw.slice(1, -1).includes('`')) throw new Error(`${filename}: cannot safely convert style string containing backtick`);
    replacements.push({ start: container.start, end: container.start + 1, value: '`' });
    replacements.push({ start: container.end - 1, end: container.end, value: '`' });
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  const check = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (check.parseDiagnostics.length) {
    throw new Error(`${filename} failed after style migration: ${check.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  }
  write(file, source);
  return candidates.length;
}

function staticActionId(page, type, handler) {
  return `s_${crypto.createHash('sha256').update(`${page}\0${type}\0${handler}`).digest('hex').slice(0, 24)}`;
}

function migrateHtml(pageName, actionScriptName) {
  const file = path.join(publicDir, pageName);
  let html = fs.readFileSync(file, 'utf8');
  const candidates = findHandlerAttributes(html);
  const registrations = new Map();
  for (const candidate of candidates.sort((a, b) => b.start - a.start)) {
    if (/\$\{/.test(candidate.handler)) throw new Error(`${pageName}: unresolved interpolation in static HTML handler`);
    const code = compileHandler(candidate.handler);
    const id = staticActionId(pageName, candidate.type, candidate.handler);
    registrations.set(id, { id, type: candidate.type, code });
    html = html.slice(0, candidate.start) + ` data-csp-${candidate.type}="${id}"` + html.slice(candidate.end);
  }
  write(file, html);
  if (registrations.size) {
    const scriptPath = path.join(publicDir, actionScriptName);
    const suffix = `\n/* Static actions migrated from ${pageName}. */\n` + [...registrations.values()]
      .map(item => `CSP.register('${item.id}','${item.type}',function(event){${item.code}});`)
      .join('\n') + '\n';
    fs.appendFileSync(scriptPath, suffix, 'utf8');
  }
  return candidates.length;
}

function migrateHtmlStyles(pageName, actionScriptName) {
  const file = path.join(publicDir, pageName);
  let html = fs.readFileSync(file, 'utf8');
  const candidates = findStyleAttributes(html);
  const registrations = new Map();
  for (const candidate of candidates.sort((a, b) => b.start - a.start)) {
    if (/\$\{/.test(candidate.css)) throw new Error(`${pageName}: unresolved interpolation in static style`);
    const id = staticActionId(pageName, 'style', candidate.css);
    registrations.set(id, { id, css: candidate.css });
    html = html.slice(0, candidate.start) + ` data-csp-style="${id}"` + html.slice(candidate.end);
  }
  write(file, html);
  if (registrations.size) {
    const scriptPath = path.join(publicDir, actionScriptName);
    const suffix = `\n/* Static styles migrated from ${pageName}. */\n` + [...registrations.values()]
      .map(item => `CSP.registerStyle('${item.id}',${JSON.stringify(item.css)});`)
      .join('\n') + '\n';
    fs.appendFileSync(scriptPath, suffix, 'utf8');
  }
  return candidates.length;
}

function assertNoInlineHandlers(files) {
  for (const filename of files) {
    const source = fs.readFileSync(path.join(publicDir, filename), 'utf8');
    const count = findHandlerAttributes(source).length;
    if (count) throw new Error(`${filename} still has ${count} inline handler(s)`);
  }
}

function removeLegacyOnclickInference() {
  const file = path.join(publicDir, 'tbl-enhance.js');
  let source = fs.readFileSync(file, 'utf8');
  const startMarker = '    const btn = findDeleteBtn(table.tBodies[0] || table);';
  const endMarker = '\n  global.enhanceDataTable = enhanceDataTable;';
  const start = source.indexOf(startMarker);
  if (start < 0) return;
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error('Cannot find legacy onclick inference end marker');
  const functionClose = source.lastIndexOf('\n  }', end);
  if (functionClose < start) throw new Error('Cannot find inferBulkDelete closing brace');
  source = source.slice(0, start)
    + "    // CSP forbids executable handler strings. Bulk actions must declare an auditable\n"
    + "    // data-bulk-delete endpoint (or pass an explicit bulkDelete option).\n"
    + "    return null;"
    + source.slice(functionClose);
  write(file, source);
}

function removeLegacyAttributeFragments() {
  const marketerPath = path.join(publicDir, 'marketer-ui.js');
  let marketer = fs.readFileSync(marketerPath, 'utf8');
  marketer = marketer.replace(
    `prodImgTag(c.image, 'style="height:40px;border-radius:6px;margin-left:8px;vertical-align:middle"')`,
    "prodImgTag(c.image, `data-csp-style=\"${CSP.style('height:40px;border-radius:6px;margin-left:8px;vertical-align:middle')}\"`)"
  );
  write(marketerPath, marketer);

  const demoPath = path.join(publicDir, 'demo.js');
  let demo = fs.readFileSync(demoPath, 'utf8');
  demo = demo.replace(
    'return `style="background:rgba(${r},${g},80,0.18)"`;',
    'return `data-csp-style="${CSP.style(`background:rgba(${r},${g},80,0.18)`)}"`;'
  );
  write(demoPath, demo);
}

function main() {
  externalizeIndex();
  externalizeStandalonePage('demo');
  externalizeStandalonePage('brochure');

  const jsFiles = ['app.js', 'marketer-ui.js', 'mdi.js', 'portal-ui.js', 'prod-ui.js', 'tbl-enhance.js', 'demo.js'];
  const migrated = {};
  for (const filename of jsFiles) migrated[filename] = migrateJavascript(filename);
  migrated['index.html'] = migrateHtml('index.html', 'app.js');
  migrated['demo.html'] = migrateHtml('demo.html', 'demo.js');
  migrated['brochure.html'] = migrateHtml('brochure.html', 'brochure.js');
  for (const filename of jsFiles) migrated[`${filename}:styles`] = migrateJavascriptStyles(filename);
  migrated['index.html:styles'] = migrateHtmlStyles('index.html', 'app.js');
  migrated['demo.html:styles'] = migrateHtmlStyles('demo.html', 'demo.js');
  migrated['brochure.html:styles'] = migrateHtmlStyles('brochure.html', 'brochure.js');
  removeLegacyOnclickInference();
  removeLegacyAttributeFragments();
  assertNoInlineHandlers([...jsFiles, 'index.html', 'demo.html', 'brochure.html']);
  console.log(JSON.stringify(migrated, null, 2));
}

main();
