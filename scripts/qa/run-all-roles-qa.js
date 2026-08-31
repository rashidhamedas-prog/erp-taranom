'use strict';
process.argv.splice(2, 0, '--mode=roles');
require('./run').main().catch((e) => { console.error(e); process.exit(2); });
