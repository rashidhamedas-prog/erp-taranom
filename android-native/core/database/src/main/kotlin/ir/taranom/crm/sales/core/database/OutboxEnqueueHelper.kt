package ir.taranom.crm.sales.core.database

import ir.taranom.crm.sales.core.database.dao.OutboxDao
import ir.taranom.crm.sales.core.database.dao.SalesDraftDao
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity
import ir.taranom.crm.sales.core.database.entity.toEntity
import ir.taranom.crm.sales.core.domain.DraftOrderService
import ir.taranom.crm.sales.core.model.OutboxOp

/**
 * Bridges domain [DraftOrderService] → Room outbox with Ed25519 proof.
 * [sign] is typically `DeviceCredentialStore::signOutboxOp` from sync:impl.
 */
object OutboxEnqueueHelper {

    suspend fun enqueueSigned(
        outboxDao: OutboxDao,
        op: OutboxOp,
        sign: (seq: Long) -> String,
    ): Long = outboxDao.insertThenSign(op.toEntity().copy(seq = 0, replayProof = null), sign)

    /**
     * Atomically persist a sales draft + signed outbox op for proforma create
     * (DraftOrderService path → OutboxDao).
     */
    suspend fun commitProformaWithOutbox(
        draftDao: SalesDraftDao,
        draft: SalesDraftEntity,
        req: DraftOrderService.ProformaRequest,
        sign: (seq: Long) -> String,
    ): Long {
        val op = DraftOrderService.buildProformaOutboxOp(req).toEntity()
        return draftDao.insertWithOutboxSigned(draft, op, sign)
    }
}
