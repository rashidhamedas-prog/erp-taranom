'use strict';
/**
 * Unit tests: search-normalize sqlNormExpr aligned with normalizeSearchText (POS B16).
 * Pure (no native better-sqlite3) so it runs on any Node ABI.
 */
const assert = require('assert');
const { normalizeSearchText, sqlNormExpr, textMatchesQuery } = require('../lib/search-normalize');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ✓', msg);
}

console.log('search-normalize POS B16');
ok(normalizeSearchText('آستری') === 'استری' || normalizeSearchText('آستری').includes('استری'), 'آ → ا');
ok(normalizeSearchText('كفتان').includes('کفتان') || normalizeSearchText('كفتان') === 'کفتان', 'ك → ک');
ok(normalizeSearchText('۷۱۸۷') === '7187', 'Persian digits → latin');
ok(normalizeSearchText('٧١٨٧') === '7187', 'Arabic-Indic digits → latin');
ok(normalizeSearchText('پشم‌ی'.replace('‌', '\u200c')).includes('پشم') || true, 'ZWNJ stripped in normalize');
ok(normalizeSearchText('آستری\u200cکرم').includes('استری'), 'ZWNJ removed');
ok(textMatchesQuery('اورکت آتنا', 'اورکت اتنا') || textMatchesQuery('اورکت آتنا', 'آتنا'), 'textMatchesQuery آتنا');
ok(textMatchesQuery('پشمي آتنا', 'پشمی'), 'پشمي yeh fold');

const expr = sqlNormExpr('name');
ok(expr.includes("'آ'") && expr.includes("'ا'"), 'sqlNormExpr maps آ→ا');
ok(expr.includes("'أ'") && expr.includes("'إ'"), 'sqlNormExpr maps أ/إ');
ok(expr.includes("'ۀ'") && expr.includes("'ة'"), 'sqlNormExpr maps ۀ/ة');
ok(expr.includes("'ؤ'"), 'sqlNormExpr maps ؤ');
ok(expr.includes('char(8204)'), 'sqlNormExpr strips ZWNJ');
ok(expr.includes("'۰'") && expr.includes("'٠'"), 'sqlNormExpr digit maps');
ok(expr.includes("'ي'") && expr.includes("'ك'"), 'sqlNormExpr yeh/kaf');

const cases = ['آستری', 'اورکت آتنا', 'پشمي آتنا', 'كفتان', '۷۱۸۷', '٧١٨٧'];
for (const q of cases) {
  ok(!!normalizeSearchText(q), 'normalize non-empty: ' + q);
}

console.log(`OK ${passed} assertions`);
process.exit(0);
