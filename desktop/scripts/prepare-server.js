'use strict';
// Compatibility wrapper. Shared rules are used by desktop, Android and CI.
const { copyRuntime } = require('../../scripts/embedded-server-files');
const result = copyRuntime('desktop');
console.log(`server sources copied into desktop/server (${result.count} files)`);
