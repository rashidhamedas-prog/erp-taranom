#!/usr/bin/env node
/** Strip user-visible "محک/Mahak" branding from index.html — rename internal UI symbols. */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../server/public/index.html');
let s = fs.readFileSync(file, 'utf8');

const idRepl = [
  ['mahakDocCell', 'refDocCell'],
  ['MAHAK_DOC_LABELS', 'REF_DOC_LABELS'],
  ['isMahakMode', 'usesExtendedCoa'],
  ['mahakOnly', 'extendedCoaOnly'],
  ['mahak-cheques', 'cheque-register'],
  ['acc-mahak-cheques', 'acc-cheque-register'],
  ['mahakBankFieldsHtml', 'bankExtraFieldsHtml'],
  ['mahakCustFieldsHtml', 'custExtraFieldsHtml'],
  ['mahakProdFieldsHtml', 'productExtraFieldsHtml'],
  ['mahakSupFieldsHtml', 'supplierExtraFieldsHtml'],
  ['mahakPersonFieldsHtml', 'personExtraFieldsHtml'],
  ['mahakPartyFieldsInner', 'partyExtraFieldsInner'],
  ['collectMahakPartyData', 'collectPartyExtraData'],
  ['editMahakChequeStatus', 'editChequeRegisterStatus'],
  ['uploadMahakBackup', 'uploadLegacyBackup'],
  ['runMahakImport', 'runLegacyImport'],
];

for (const [a, b] of idRepl) {
  s = s.split(a).join(b);
}

const textRepl = [
  ['سند محک', 'سند مرجع'],
  ['دفتر چک محک', 'دفتر چک'],
  ['گروه‌های اشخاص (محک)', 'گروه‌های اشخاص'],
  ['گروه‌های کالا (محک)', 'گروه‌های کالا'],
  ['گروه اشخاص (محک)', 'گروه اشخاص'],
  ['گروه‌های استاندارد محک', 'گروه‌های استاندارد'],
  ['فیلدهای محک', 'فیلدهای تکمیلی'],
  ['کدینگ محک', 'کدینگ تفصیلی'],
  ['مطابق محک', 'طبق استاندارد حسابداری'],
  ['اسناد محک', 'اسناد مرجع'],
  ['مهاجرت محک', 'مهاجرت داده'],
  ['از محک', 'از سیستم قبلی'],
  ['واردات از محک (Mahak)', 'واردات از سیستم قبلی'],
  ['Mahak', ''],
  ['محک ', ''],
  [' محک', ''],
  ['کد عملیاتی محک', 'کد عملیاتی'],
  ['مثل محک', 'طبق استاندارد'],
  ['حالت کدینگ محک', 'حالت کدینگ تفصیلی'],
  ['پس از مهاجرت محک', 'پس از واردات داده'],
  ['full data.xlsx', 'فایل داده'],
  ['MAHAK_MSSQL_*', 'LEGACY_MSSQL_*'],
  ['docs/MAHAK-IMPORT.md', 'docs/DATA-IMPORT.md'],
];

for (const [a, b] of textRepl) {
  s = s.split(a).join(b);
}

// Fix refDocCell label
s = s.replace(
  /return `<span class="mono" title="\$\{esc\(lbl\)\}">محک \$\{esc\(String\(docNo\)\)\}<\/span>`;/,
  "return `<span class=\"mono\" title=\"${esc(lbl)}\">مرجع ${esc(String(docNo))}</span>`;"
);
s = s.replace(
  /return `<span class="mono" title="\$\{esc\(lbl\)\}">\$\{esc\(String\(docNo\)\)\}<\/span>`;/,
  "return `<span class=\"mono\" title=\"${esc(lbl)}\">مرجع ${esc(String(docNo))}</span>`;"
);

fs.writeFileSync(file, s);
console.log('purge-mahak-ui: index.html updated');
