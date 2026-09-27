package ir.taranom.crm.sales.migrate

/**
 * Migrator فاز ۵: تشخیص DB نسخهٔ nodejs-mobile و کپی جداول فروش مجاز + outbox pending
 * به Room بومی، با قواعد fail-closed هویت دستگاه.
 *
 * **هرگز** `device_token` / HMAC / کلید خصوصی replay را plaintext کپی یا export نمی‌کند.
 * Keystore alias JWT (`erp_taranom_jwt_aes_gcm_v1`) روی همان `applicationId` دست‌نخورده می‌ماند.
 */
class LegacyDbMigrator(
    private val source: LegacySqliteSource,
    private val sink: NativeMigrationSink,
) {

    fun detect(): Boolean = source.exists() && source.tableExists("customers")

    fun migrate(dryRun: Boolean = false): MigrationOutcome {
        if (!source.exists()) return MigrationOutcome.Skipped(FailClosedRules.NO_LEGACY_DB)

        val kvRows = if (source.tableExists("sync_local_kv")) {
            source.queryRows("sync_local_kv", listOf("key", "value"))
        } else {
            emptyList()
        }
        val kv = kvRows.associate { (it["key"] ?: "") to it["value"] }
        val legacyDeviceId = kv["device_id"]?.toLongOrNull()
        val centralUrl = kv["central_url"]?.takeIf { !it.isNullOrBlank() }
        val secretsPresent = kv.keys.any { ForbiddenSecretKeys.isForbidden(it) } ||
            kv.values.any { it != null && it.startsWith("enc:v1:") }

        val decision = FailClosedRules.decideIdentity(sink.nativeDeviceId(), legacyDeviceId)
        if (decision is IdentityDecision.Abort) {
            return MigrationOutcome.Aborted(decision.code)
        }

        if (!source.tableExists("customers")) {
            return MigrationOutcome.Aborted(FailClosedRules.LEGACY_UNREADABLE, "customers_missing")
        }

        val customerRows = source.queryRows(
            "customers",
            listOf("id", "biz", "owner", "city", "phone", "user_id", "version", "created_at"),
        ).mapNotNull { row ->
            val id = row["id"]?.toLongOrNull() ?: return@mapNotNull null
            val biz = row["biz"]?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val createdSec = row["created_at"]?.toLongOrNull() ?: 0L
            LegacyCustomerRow(
                id = id,
                businessName = biz,
                ownerName = row["owner"],
                city = row["city"],
                phone = row["phone"],
                ownerUserId = row["user_id"]?.toLongOrNull(),
                version = row["version"]?.toLongOrNull() ?: 0L,
                updatedAtEpochMs = if (createdSec > 1_000_000_000_000L) createdSec else createdSec * 1000L,
            )
        }

        val outboxRows = if (!source.tableExists("sync_outbox")) {
            emptyList()
        } else {
            source.queryRows(
                "sync_outbox",
                listOf(
                    "id", "method", "path", "body_json", "user_id", "base_version",
                    "captured_rows_json", "replay_proof", "status", "attempts", "reason", "created_at",
                ),
                where = "status IN ('pending','sending','failed')",
            ).mapNotNull { row ->
                val seq = row["id"]?.toLongOrNull() ?: return@mapNotNull null
                val proof = row["replay_proof"]
                if (proof.isNullOrBlank()) return@mapNotNull null
                val method = row["method"] ?: return@mapNotNull null
                val path = row["path"] ?: return@mapNotNull null
                val userId = row["user_id"]?.toLongOrNull() ?: return@mapNotNull null
                val createdSec = row["created_at"]?.toLongOrNull() ?: 0L
                LegacyOutboxRow(
                    id = seq,
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

        for (c in customerRows) {
            if (sink.hasCustomerLocalId(c.id)) {
                return MigrationOutcome.Aborted(FailClosedRules.CUSTOMER_ID_COLLISION, "local_id=${c.id}")
            }
        }
        for (o in outboxRows) {
            if (sink.hasOutboxSeq(o.id)) {
                return MigrationOutcome.Aborted(FailClosedRules.OUTBOX_SEQ_COLLISION, "seq=${o.id}")
            }
        }

        val notes = mutableListOf<String>()
        if (secretsPresent) notes += "legacy_secrets_detected_not_copied"
        when (decision) {
            is IdentityDecision.ImportHintRequiresRepair ->
                notes += FailClosedRules.IDENTITY_REQUIRES_REPAIR + ":device_id=${decision.legacyDeviceId}"
            is IdentityDecision.ContinueSameDevice ->
                notes += "same_device_id=${decision.deviceId}"
            else -> Unit
        }
        if (centralUrl != null) notes += "central_url_hint_present"

        if (dryRun) {
            return MigrationOutcome.Completed(
                customersCopied = customerRows.size,
                outboxCopied = outboxRows.size,
                identity = decision,
                notes = listOf("dry_run") + notes,
            )
        }

        customerRows.forEach { sink.insertCustomer(it) }
        outboxRows.forEach { sink.insertOutbox(it) }

        return MigrationOutcome.Completed(
            customersCopied = customerRows.size,
            outboxCopied = outboxRows.size,
            identity = decision,
            notes = notes,
        )
    }
}
