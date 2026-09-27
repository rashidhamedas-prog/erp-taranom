package ir.taranom.crm.sales.core.model

/**
 * مبلغ = **ریال صحیح** (Long). هیچ مبلغی در این محصول اعشاری نیست — عیناً همان
 * قاعدهٔ سرور: «Money stays INTEGER rial — only qty/stock use REAL + round3»
 * (`server/lib/round3.js`).
 */
typealias Rial = Long

/**
 * مقدار (qty) = عدد اعشاری با حداکثر ۳ رقم (پارچه/متراژ). گرد کردن فقط از
 * `ir.taranom.crm.sales.core.domain.Round3`.
 */
typealias Qty = Double
