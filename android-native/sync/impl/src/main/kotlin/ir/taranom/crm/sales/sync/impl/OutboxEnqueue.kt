package ir.taranom.crm.sales.sync.impl

import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.sync.impl.credentials.DeviceCredentialStore

/**
 * Sign an outbox op after its seq is allocated (seq is inside the Ed25519 envelope).
 */
fun DeviceCredentialStore.signOutboxOp(op: OutboxOp, seq: Long): String =
    signOutboxBody(
        seq = seq,
        method = op.method,
        path = op.path,
        userId = op.userId,
        bodyJson = op.bodyJson,
        fileHash = op.fileHash.orEmpty(),
        fileField = op.fileField.orEmpty(),
    )
