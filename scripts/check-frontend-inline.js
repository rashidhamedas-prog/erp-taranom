'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'server/public/index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
blocks.forEach((source, index) => new vm.Script(source, { filename: `index.inline.${index + 1}.js` }));
console.log(`frontend inline scripts parsed: ${blocks.length}`);
