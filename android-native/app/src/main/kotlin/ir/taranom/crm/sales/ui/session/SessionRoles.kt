package ir.taranom.crm.sales.ui.session

import ir.taranom.crm.sales.core.model.RolePermissions

/**
 * نشست محلی موقت تا Keystore/pairing وصل شود.
 * نقش‌ها از سیاست سرور می‌آیند؛ نبود فروشگاه سیاست ⇒ پیش‌فرض فروشندهٔ میدانی.
 */
object SessionRoles {
    @Volatile
    var userId: Long = 1L
        private set

    @Volatile
    var repId: Long = 1L
        private set

    @Volatile
    private var roles: Set<String> = RolePermissions.defaultFieldRoles()

    fun currentRoles(): Set<String> = roles

    fun signIn(userId: Long, repId: Long = userId, roles: Set<String>? = null) {
        this.userId = userId
        this.repId = repId
        this.roles = roles?.takeIf { it.isNotEmpty() } ?: RolePermissions.defaultFieldRoles()
    }

    fun canCreateProforma(): Boolean = RolePermissions.canCreateProforma(roles)
    fun canCreateFinalInvoice(): Boolean = RolePermissions.canCreateFinalInvoice(roles)
    fun canCreateReturn(): Boolean = RolePermissions.canCreateReturn(roles)
    fun canCreateReceipt(): Boolean = RolePermissions.canCreateReceipt(roles)
}
