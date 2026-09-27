package ir.taranom.crm.sales.migrate

/**
 * Migrator فاز ۵: تشخیص DB نسخهٔ nodejs-mobile و کپی جداول فروش مجاز + outbox pending
 * به Room بومی، با قواعد fail-closed هویت دستگاه.
 *
 * **هرگز** `device_token` / HMAC / کلید خصوصی replay را plaintext کپی یا export نمی‌کند.
 * Keystore alias JWT (`erp_taranom_jwt_aes_gcm_v1`) روی همان `applicationId` دست‌نخورده می‌ماند.
 *
 * @param identityProbe اختیاری؛ پیش‌فرض از `sync_local_kv` می‌خواند (بدون export secrets).
 */
class LegacyDbMigrator(
    private val source: LegacySqliteSource,
    private val sink: NativeMigrationSink,
    private val identityProbe: () -> LegacyIdentityProbe = { defaultIdentityProbe(source) },
) {

    fun detect(): Boolean = source.exists() && source.tableExists("customers")

    fun migrate(dryRun: Boolean = false): MigrationOutcome {
        if (!source.exists()) return MigrationOutcome.Skipped(FailClosedRules.NO_LEGACY_DB)
        if (!source.tableExists("customers")) {
            return MigrationOutcome.Aborted(FailClosedRules.LEGACY_UNREADABLE, "customers_missing")
        }

        val probe = identityProbe()
        val decision = FailClosedRules.decideIdentity(
            nativeDeviceId = sink.nativeDeviceId(),
            legacyDeviceId = probe.deviceId,
        )
        if (decision is IdentityDecision.Abort) {
            return MigrationOutcome.Aborted(decision.code)
        }

        val customers = readCustomers()
        val outbox = readPendingOutbox()

        for (c in customers) {
            if (sink.hasCustomerLocalId(c.id)) {
                return MigrationOutcome.Aborted(
                    FailClosedRules.CUSTOMER_ID_COLLISION,
                    "local_id=${c.id}",
                )
            }
        }
        for (o in outbox) {
            if (sink.hasOutboxSeq(o.id)) {
                return MigrationOutcome.Aborted(
                    FailClosedRules.OUTBOX_SEQ_COLLISION,
                    "seq=${o.id}",
                )
            }
        }

        val notes = identityNotes(probe, decision)
        if (dryRun) {
            return MigrationOutcome.Completed(
                customersCopied = customers.size,
                outboxCopied = outbox.size,
                identity = decision,
                notes = listOf("dry_run") + notes,
            )
        }

        customers.forEach { sink.insertCustomer(it) }
        outbox.forEach { sink.insertOutbox(it) }

        return MigrationOutcome.Completed(
            customersCopied = customers.size,
            outboxCopied = outbox.size,
            identity = decision,
            notes = notes,
        )
    }

    private fun identityNotes(probe: LegacyIdentityProbe, decision: IdentityDecision): List<String> {
        val notes = mutableListOf<String>()
        if (probe.secretsPresentButNotExported) {
            notes += "legacy_secrets_detected_not_copied"
        }
        when (decision) {
            is IdentityDecision.ImportHintRequiresRepair ->
                notes += FailClosedRules.IDENTITY_REQUIRES_REPAIR + ":device_id=${decision.legacyDeviceId}"
            is IdentityDecision.ContinueSameDevice ->
                notes += "same_device_id=${decision.deviceId}"
            else -> Unit
        }
        probe.centralUrl?.let { notes += "central_url_hint_present" }
        return notes
    }

    fun readCustomers(): List<LegacyCustomerRow> {
        val useCols = listOf("id", "biz", "owner", "city", "phone", "user_id", "version", "created_at")
        return source.queryRows("customers", useCols).mapNotNull { row ->
            val id = row["id"]?.toLongOrNull() ?: return@mapNotNull null
            val biz = row["biz"]?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val ownerUser = row["user_id"]?.toLongOrNull()
            val createdSec = row["created_at"]?.toLongOrNull() ?: 0L
            LegacyCustomerRow(
                id = id,
                businessName = biz,
                ownerName = row["owner"],
                city = row["city"],
                phone = row["phone"],
                ownerUserId = ownerUser,
                version = row["version"]?.toLongOrNull() ?: 0L,
                updatedAtEpochMs = if (createdSec > 1_000_000_000_000L) createdSec else createdSec * 1000L,
            )
        }
    }

    fun readPendingOutbox(): List<LegacyOutboxRow> {
        if (!source.tableExists("sync_outbox")) return emptyList()
        val cols = listOf(
            "id", "method", "path", "body_json", "user_id", "base_version",
            "captured_rows_json", "replay_proof", "status", "attempts", "reason", "created_at",
        )
        return source.queryRows(
            table = "sync_outbox",
            columns = cols,
            where = "status IN ('pending','sending','failed')",
        ).mapNotNull { row ->
            val id = row["id"]?.toLongOrNull() ?: return@mapNotNull null
            val method = row["method"] ?: return@mapNotNull null
            val path = row["path"] ?: return@mapNotNull null
            val userId = row["user_id"]?.toLongOrNull() ?: return@mapNotNull null
            // بدون replay_proof امضاشده، مرکز رد می‌کند — کپی نمی‌کنیم (fail-closed).
            val proof = row["replay_proof"]
            if (proof.isNullOrBlank()) return@mapNotNull null
            val createdSec = row["created_at"]?.toLongOrNull() ?: 0L
            LegacyOutboxRow(
                id = id,
                method = method,
                path = path,
                bodyJson = row["body_json"] ?: "{}",
                userId = userId,
                baseVersion = row["base_version"]?.toLongOrNull(),
                capturedRowsJson = row["captured_rows_json"],
                replayProof = proof,
                status = "pending",
                attempts = row["attempts"]?.toIntOrNull() ?: 0,
                lastError = row["reason"],
                createdAtEpochMs = if (createdSec > 1_000_000_000_000L) createdSec else createdSec * 1000L,
            )
        }
    }

    companion object {
        fun defaultIdentityProbe(source: LegacySqliteSource): LegacyIdentityProbe {
            if (!source.tableExists("sync_local_kv")) {
                return LegacyIdentityProbe(null, null, false)
            }
            val rows = source.queryRows("sync_local_kv", listOf("key", "value"))
            var deviceId: Long? = null
            var centralUrl: String? = null
            var secretsPresent = false
            for (row in rows) {
                val key = row["key"] ?: continue
                val value = row["value"]
                when {
                    ForbiddenSecretKeys.isForbidden(key) -> secretsPresent = true
                    key == "device_id" -> deviceId = value?.toLongOrNull()
                    key == "central_url" -> centralUrl = value?.takeIf { it.isNotBlank() }
                    value != null && value.startsWith("enc:v1:") -> secretsPresent = true
                }
            }
            return LegacyIdentityProbe(deviceId, centralUrl, secretsPresent)
        }
    }
}
