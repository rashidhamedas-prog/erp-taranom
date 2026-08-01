'use strict';
const { TARGETS, copyRuntime } = require('./embedded-server-files');
const requested = process.argv[2] || 'all';
const names = requested === 'all' ? Object.keys(TARGETS) : [requested];
for (const name of names) {
  const result = copyRuntime(name);
  console.log(`embedded prepare: ${name} <- server (${result.count} files)`);
}
