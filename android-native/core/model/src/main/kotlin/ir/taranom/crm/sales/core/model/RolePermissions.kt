package ir.taranom.crm.sales.core.model

/**
 * دروازهٔ نقش برای صفحات مالی محدود.
 * اگر فروشگاه سیاست (policy store) هنوز وصل نباشد، نقش پیش‌فرض فروشندهٔ میدانی
 * فقط پیش‌فاکتور/CRM را باز می‌گذارد؛ فاکتور رسمی/برگشت/وصول نیاز به نقش گسترده‌تر دارند.
 */
object RolePermissions {
    const val ROLE_FIELD_SALES = "field_sales"
    const val ROLE_INSIDE_SALES = "inside_sales"
    const val ROLE_ACCOUNTING = "accounting"
    const val ROLE_ADMIN = "admin"

    fun canOpenCrm(roles: Set<String>): Boolean = roles.isNotEmpty()

    fun canCreateProforma(roles: Set<String>): Boolean =
        roles.any {
            it == ROLE_FIELD_SALES || it == ROLE_INSIDE_SALES ||
                it == ROLE_ACCOUNTING || it == ROLE_ADMIN
        }

    fun canCreateFinalInvoice(roles: Set<String>): Boolean =
        roles.any { it == ROLE_INSIDE_SALES || it == ROLE_ACCOUNTING || it == ROLE_ADMIN }

    fun canCreateReturn(roles: Set<String>): Boolean =
        roles.any { it == ROLE_ACCOUNTING || it == ROLE_ADMIN }

    fun canCreateReceipt(roles: Set<String>): Boolean =
        roles.any {
            it == ROLE_INSIDE_SALES || it == ROLE_ACCOUNTING || it == ROLE_ADMIN
        }

    fun canReviewConflicts(roles: Set<String>): Boolean = roles.isNotEmpty()

    /** نقش پیش‌فرض وقتی SessionRoles هنوز از Keystore پر نشده. */
    fun defaultFieldRoles(): Set<String> = setOf(ROLE_FIELD_SALES)
}
