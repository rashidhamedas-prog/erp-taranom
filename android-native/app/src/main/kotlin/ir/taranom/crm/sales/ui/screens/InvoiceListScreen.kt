package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import ir.taranom.crm.sales.core.database.entity.InvoiceEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.domain.FinancialCaptureService
import ir.taranom.crm.sales.core.model.LocalIdAllocator
import ir.taranom.crm.sales.core.model.OutboxStatus
import ir.taranom.crm.sales.core.model.ProvisionalIds
import ir.taranom.crm.sales.core.model.SalesDraft
import ir.taranom.crm.sales.core.model.SyncState
import ir.taranom.crm.sales.ui.session.SessionRoles
import kotlinx.coroutines.launch

@Composable
fun InvoiceListScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val items by db.invoiceDao().observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var customerId by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    val canProforma = SessionRoles.canCreateProforma()
    val canFinal = SessionRoles.canCreateFinalInvoice()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.nav_invoices), style = MaterialTheme.typography.headlineSmall)
        if (!canProforma) {
            Text(stringResource(R.string.rbac_denied), color = MaterialTheme.colorScheme.error)
        } else {
            Text(stringResource(R.string.invoices_hint), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(
                value = customerId,
                onValueChange = { customerId = it.filter(Char::isDigit) },
                label = { Text(stringResource(R.string.field_customer_id)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = date,
                onValueChange = { date = it },
                label = { Text(stringResource(R.string.field_date_jalali)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it.filter(Char::isDigit) },
                label = { Text(stringResource(R.string.field_amount_rial)) },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
            )
            Button(
                onClick = {
                    saveInvoice(
                        scope, db, customerId, date, amount, type = "proforma",
                        onMsg = { message = it },
                        ctxMsg = context.getString(R.string.saved_local_outbox),
                    )
                },
                enabled = canProforma,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.action_create_proforma)) }
            Button(
                onClick = {
                    saveInvoice(
                        scope, db, customerId, date, amount, type = "final",
                        onMsg = { message = it },
                        ctxMsg = context.getString(R.string.saved_local_outbox),
                    )
                },
                enabled = canFinal,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.action_create_final_invoice)) }
            if (!canFinal) {
                Text(stringResource(R.string.rbac_final_stub), style = MaterialTheme.typography.labelMedium)
            }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(items, key = { it.localId }) { row ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier = Modifier.padding(12.dp)) {
                        Text("${row.documentNumber} · ${row.type}", style = MaterialTheme.typography.titleMedium)
                        Text("${row.date} · ${row.totalAmount} ریال", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

private fun saveInvoice(
    scope: kotlinx.coroutines.CoroutineScope,
    db: ir.taranom.crm.sales.core.database.TaranomSalesDatabase,
    customerId: String,
    date: String,
    amount: String,
    type: String,
    onMsg: (String) -> Unit,
    ctxMsg: String,
) {
    val cid = customerId.toLongOrNull() ?: return
    val total = amount.toLongOrNull() ?: return
    if (date.isBlank()) return
    scope.launch {
        val floor = ProvisionalIds.tableBase(1, LocalIdAllocator.TABLE_INVOICES)
        val id = LocalIdAllocator.next(1, LocalIdAllocator.TABLE_INVOICES, db.invoiceDao().maxProvisionalId(floor))
        val now = System.currentTimeMillis()
        val entity = InvoiceEntity(
            localId = id,
            customerLocalId = cid,
            documentNumber = "${SalesDraft.TEMP_NUMBER_PREFIX}$id",
            type = type,
            date = date,
            subtotal = total,
            totalAmount = total,
            syncState = SyncState.PENDING_PUSH.wireValue,
            createdAt = now,
            updatedAt = now,
        )
        val body = FinancialCaptureService.buildLimitedInvoiceBody(
            customerId = cid,
            type = type,
            date = date,
            note = null,
            subtotal = total,
            discountAmount = 0,
            finalAmount = total,
            localDraftId = id.toString(),
        )
        val op = OutboxOpEntity(
            method = FinancialCaptureService.INVOICE_METHOD,
            path = FinancialCaptureService.INVOICE_PATH,
            bodyJson = body,
            userId = SessionRoles.userId,
            status = OutboxStatus.PENDING.wireValue,
            createdAt = now,
        )
        db.invoiceDao().insertWithOutbox(entity, op)
        onMsg(ctxMsg)
    }
}
