package ir.taranom.crm.sales.migrate

/**
 * قواعد fail-closed مهاجرت و بکاپ — منبع حقیقت برای تست و مستندات.
 *
 * هر نقض ⇒ [MigrationOutcome.Aborted]؛ هرگز «بهترین تلاش» خاموش.
 */
object FailClosedRules {

    const val NO_LEGACY_DB = "legacy_db_missing"
    const val LEGACY_UNREADABLE = "legacy_db_unreadable"
    const val DEVICE_ID_CONFLICT = "device_id_conflict"
    const val NATIVE_ALREADY_PAIRED = "native_already_paired_refuse_blind_copy"
    const val SECRET_KEY_IN_EXPORT = "refusing_export_of_device_secret"
    const val SECRET_VALUE_PLAINTEXT = "refusing_plaintext_secret_value"
    const val OUTBOX_SEQ_COLLISION = "outbox_seq_collision"
    const val CUSTOMER_ID_COLLISION = "customer_id_collision"
    const val UNSUPPORTED_TABLE = "unsupported_legacy_table"
    const val BACKUP_TAMPERED = "backup_mac_invalid"
    const val BACKUP_PASSPHRASE_WEAK = "backup_passphrase_too_weak"
    const val IDENTITY_REQUIRES_REPAIR = "identity_requires_repair_not_blind_import"

    /**
     * تصمیم هویت دستگاه.
     *
     * - اگر Room هنوز unpaired است و legacy `device_id` دارد → می‌توان شناسه را
     *   به‌عنوان hint نگه داشت ولی **توکن/HMAC را کپی نمی‌کنیم** ⇒ re-pair لازم.
     * - اگر هر دو paired و `device_id` متفاوت ⇒ abort.
     * - اگر هر دو paired و یکسان ⇒ فقط دادهٔ فروش؛ اسرار از Keystore همان نصب می‌مانند.
     */
    fun decideIdentity(
        nativeDeviceId: Long?,
        legacyDeviceId: Long?,
    ): IdentityDecision = when {
        nativeDeviceId != null && legacyDeviceId != null && nativeDeviceId != legacyDeviceId ->
            IdentityDecision.Abort(DEVICE_ID_CONFLICT)
        nativeDeviceId != null && legacyDeviceId != null && nativeDeviceId == legacyDeviceId ->
            IdentityDecision.ContinueSameDevice(nativeDeviceId)
        nativeDeviceId != null && legacyDeviceId == null ->
            IdentityDecision.Abort(NATIVE_ALREADY_PAIRED)
        nativeDeviceId == null && legacyDeviceId != null ->
            IdentityDecision.ImportHintRequiresRepair(legacyDeviceId)
        else ->
            IdentityDecision.FreshInstallNoLegacyIdentity
    }
}

sealed class IdentityDecision {
    data class Abort(val code: String) : IdentityDecision()
    data class ContinueSameDevice(val deviceId: Long) : IdentityDecision()
    data class ImportHintRequiresRepair(val legacyDeviceId: Long) : IdentityDecision()
    data object FreshInstallNoLegacyIdentity : IdentityDecision()
}
