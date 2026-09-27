package ir.taranom.crm.sales.migrate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentityPolicyTest {
    @Test
    fun abortsOnConflictingDeviceIds() {
        val d = FailClosedRules.decideIdentity(nativeDeviceId = 7, legacyDeviceId = 9)
        assertTrue(d is IdentityDecision.Abort)
        assertEquals(FailClosedRules.DEVICE_ID_CONFLICT, (d as IdentityDecision.Abort).code)
    }

    @Test
    fun requiresRepairWhenImportingLegacyHint() {
        val d = FailClosedRules.decideIdentity(nativeDeviceId = null, legacyDeviceId = 42)
        assertTrue(d is IdentityDecision.ImportHintRequiresRepair)
    }

    @Test
    fun continuesWhenSameDevice() {
        val d = FailClosedRules.decideIdentity(7, 7)
        assertTrue(d is IdentityDecision.ContinueSameDevice)
    }
}

class ForbiddenSecretKeysTest {
    @Test
    fun blocksTokenAndHmacKeys() {
        assertTrue(ForbiddenSecretKeys.isForbidden("device_token"))
        assertTrue(ForbiddenSecretKeys.isForbidden("device_hmac_key"))
        assertTrue(ForbiddenSecretKeys.isForbidden("replay_private_key"))
        assertFalse(ForbiddenSecretKeys.isForbidden("device_id"))
        assertFalse(ForbiddenSecretKeys.isForbidden("central_url"))
    }
}

class LegacyDbMigratorTest {
    @Test
    fun failClosedOnCustomerCollision() {
        val source = FakeLegacySource(
            customers = listOf(
                mapOf(
                    "id" to "1001",
                    "biz" to "بوتيك",
                    "owner" to null,
                    "city" to "مشهد",
                    "phone" to null,
                    "user_id" to "5",
                    "assigned_to" to null,
                    "version" to "1",
                    "created_at" to "1700000000",
                ),
            ),
            outbox = emptyList(),
            kv = mapOf("device_id" to "7", "device_token" to "enc:v1:xx"),
        )
        val sink = FakeSink(nativeDeviceId = null, existingCustomerIds = setOf(1001L))
        val outcome = LegacyDbMigrator(source, sink).migrate()
        assertTrue(outcome is MigrationOutcome.Aborted)
        assertEquals(
            FailClosedRules.CUSTOMER_ID_COLLISION,
            (outcome as MigrationOutcome.Aborted).code,
        )
    }

    @Test
    fun copiesPendingOutboxAndSkipsSecrets() {
        val source = FakeLegacySource(
            customers = listOf(
                mapOf(
                    "id" to "2002",
                    "biz" to "فروشگاه",
                    "owner" to "علی",
                    "city" to null,
                    "phone" to "0915",
                    "user_id" to "3",
                    "assigned_to" to "3",
                    "version" to "0",
                    "created_at" to "1700000000",
                ),
            ),
            outbox = listOf(
                mapOf(
                    "id" to "11",
                    "method" to "POST",
                    "path" to "/api/customers",
                    "body_json" to "{}",
                    "user_id" to "3",
                    "base_version" to null,
                    "captured_rows_json" to null,
                    "replay_proof" to "proof",
                    "status" to "pending",
                    "attempts" to "0",
                    "reason" to null,
                    "created_at" to "1700000001",
                ),
            ),
            kv = mapOf(
                "device_id" to "7",
                "central_url" to "https://erp.poshaktaranom.com",
                "device_token" to "enc:v1:abc",
            ),
        )
        val sink = FakeSink(nativeDeviceId = null)
        val outcome = LegacyDbMigrator(source, sink).migrate()
        assertTrue(outcome is MigrationOutcome.Completed)
        val done = outcome as MigrationOutcome.Completed
        assertEquals(1, done.customersCopied)
        assertEquals(1, done.outboxCopied)
        assertTrue(done.notes.any { it.contains("legacy_secrets_detected_not_copied") })
        assertTrue(done.notes.any { it.startsWith(FailClosedRules.IDENTITY_REQUIRES_REPAIR) })
        assertEquals(1, sink.insertedCustomers.size)
        assertEquals(1, sink.insertedOutbox.size)
    }
}

class SecureBackupCodecTest {
    @Test
    fun roundTripWithoutSecrets() {
        val payload = SecureBackupCodec.buildPayloadJson(
            deviceIdHint = 7,
            customersJson = """[{"local_id":1,"business_name":"A"}]""",
            outboxJson = """[]""",
            createdAtEpochMs = 1L,
        )
        val pass = "sixteen-chars!!!".toCharArray()
        val env = SecureBackupCodec.exportEncrypted(payload, pass)
        val back = SecureBackupCodec.importDecrypted(env, pass)
        assertTrue(back.contains("\"secrets_exported\":false"))
        assertTrue(back.contains("\"device_id_hint\":7"))
    }

    @Test
    fun refusesPayloadContainingDeviceToken() {
        var threw = false
        try {
            SecureBackupCodec.assertNoSecrets("""{"device_token":"x"}""")
        } catch (_: Exception) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun kvFilterAllowsOnlySafeIdentityKeys() {
        assertTrue(SecureBackupKvFilter.allowKey("device_id"))
        assertFalse(SecureBackupKvFilter.allowKey("device_token"))
    }
}

private class FakeLegacySource(
    private val customers: List<Map<String, String?>>,
    private val outbox: List<Map<String, String?>>,
    private val kv: Map<String, String?>,
) : LegacySqliteSource {
    override fun exists(): Boolean = true
    override fun tableExists(name: String): Boolean = true
    override fun queryRows(
        table: String,
        columns: List<String>,
        where: String?,
    ): List<Map<String, String?>> = when (table) {
        "customers" -> customers
        "sync_outbox" -> outbox
        "sync_local_kv" -> kv.map { (k, v) -> mapOf("key" to k, "value" to v) }
        else -> emptyList()
    }
    override fun close() = Unit
}

private class FakeSink(
    private val nativeDeviceId: Long?,
    private val existingCustomerIds: Set<Long> = emptySet(),
    private val existingOutboxSeqs: Set<Long> = emptySet(),
) : NativeMigrationSink {
    val insertedCustomers = mutableListOf<LegacyCustomerRow>()
    val insertedOutbox = mutableListOf<LegacyOutboxRow>()
    override fun nativeDeviceId(): Long? = nativeDeviceId
    override fun hasAnyCustomer(): Boolean = existingCustomerIds.isNotEmpty() || insertedCustomers.isNotEmpty()
    override fun hasOutboxSeq(seq: Long): Boolean = seq in existingOutboxSeqs || insertedOutbox.any { it.id == seq }
    override fun hasCustomerLocalId(localId: Long): Boolean =
        localId in existingCustomerIds || insertedCustomers.any { it.id == localId }
    override fun insertCustomer(row: LegacyCustomerRow) {
        insertedCustomers += row
    }
    override fun insertOutbox(row: LegacyOutboxRow) {
        insertedOutbox += row
    }
}
