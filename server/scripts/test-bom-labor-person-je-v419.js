/**
 * Deprecated alias — SW v499 restored piece/hourly → person payable.
 * Kept so old CHANGE-LOG / runbooks that call this filename still work.
 * Canonical: server/scripts/test-bom-labor-person-je-v499.js
 */
'use strict';
console.log('NOTE: v419 assertions were flipped by ADR-005/v426; policy restored in v499.');
console.log('Delegating to test-bom-labor-person-je-v499.js …\n');
require('./test-bom-labor-person-je-v499.js');
