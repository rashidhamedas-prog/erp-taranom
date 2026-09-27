package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftLineEntity
import ir.taranom.crm.sales.core.domain.DraftOrderService
import ir.taranom.crm.sales.core.domain.LineBuilder
import ir.taranom.crm.sales.core.domain.VatCalculator
import ir.taranom.crm.sales.core.model.LocalIdAllocator
import ir.taranom.crm.sales.core.model.ProvisionalIds
import ir.taranom.crm.sales.core.model.SalesDraft
import ir.taranom.crm.sales.core.model.SyncState
import ir.taranom.crm.sales.ui.session.SessionRoles
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * سبد / پیش‌فاکتور با بازیابی پایدار از Room (سربرگ + خطوط).
 */
@Composable
fun CartOrderScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val draftDao = db.salesDraftDao()
    val latest by draftDao.observeLatestOpen().collectAsState(initial = null)
    val scope = rememberCoroutineScope()

    var draftLocalId by remember { mutableStateOf<Long?>(null) }
    var customerId by remember { mutableStateOf("") }
    var productId by remember { mutableStateOf("") }
    var productName by remember { mutableStateOf("") }
    var qty by remember { mutableStateOf("1") }
    var price by remember { mutableStateOf("100000") }
    var variantColor by remember { mutableStateOf("") }
    var variantSize by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var restored by remember { mutableStateOf(false) }

    LaunchedEffect(latest) {
        if (restored || latest == null) return@LaunchedEffect
        val d = latest!!
        draftLocalId = d.localId
        customerId = d.customerLocalId.toString()
        val lines = draftDao.linesForDraft(d.localId)
        if (lines.isNotEmpty()) {
            val line = lines.first()
            productId = line.productLocalId.toString()
            productName = line.productName
            qty = line.qty.toString()
            price = line.unitPrice.toString()
            variantColor = line.variantColor.orEmpty()
            variantSize = line.variantSize.orEmpty()
        }
        status = context.getString(R.string.cart_restored)
        restored = true
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.nav_cart), style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.cart_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        status?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(
            value = customerId,
            onValueChange = { customerId = it.filter { ch -> ch.isDigit() } },
            label = { Text(stringResource(R.string.field_customer_id)) },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
        OutlinedTextField(
            value = productId,
            onValueChange = { productId = it.filter { ch -> ch.isDigit() } },
            label = { Text(stringResource(R.string.field_product_id)) },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
        OutlinedTextField(
            value = productName,
            onValueChange = { productName = it },
            label = { Text(stringResource(R.string.field_product_name)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = qty,
            onValueChange = { qty = it },
            label = { Text(stringResource(R.string.field_qty)) },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            singleLine = true,
        )
        OutlinedTextField(
            value = price,
            onValueChange = { price = it.filter { ch -> ch.isDigit() } },
            label = { Text(stringResource(R.string.field_price_rial)) },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
        OutlinedTextField(
            value = variantColor,
            onValueChange = { variantColor = it },
            label = { Text(stringResource(R.string.field_variant_color)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = variantSize,
            onValueChange = { variantSize = it },
            label = { Text(stringResource(R.string.field_variant_size)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = {
                val cid = customerId.toLongOrNull() ?: return@Button
                val pid = productId.toLongOrNull() ?: return@Button
                val unit = price.toLongOrNull() ?: return@Button
                scope.launch {
                    val now = System.currentTimeMillis()
                    val draftFloor = ProvisionalIds.tableBase(1, LocalIdAllocator.TABLE_SALES_DRAFTS)
                    val lineFloor = ProvisionalIds.tableBase(1, LocalIdAllocator.TABLE_SALES_DRAFT_LINES)
                    val dId = draftLocalId ?: LocalIdAllocator.next(
                        1,
                        LocalIdAllocator.TABLE_SALES_DRAFTS,
                        draftDao.maxProvisionalId(draftFloor),
                    )
                    val lineId = LocalIdAllocator.next(
                        1,
                        LocalIdAllocator.TABLE_SALES_DRAFT_LINES,
                        draftDao.maxLineProvisionalId(lineFloor),
                    )
                    val built = LineBuilder.buildRows(listOf(LineBuilder.InputLine(pid, qty, unit)))
                    val totals = VatCalculator.calcDocTotals(lines = LineBuilder.toVatLines(built), vatExempt = true)
                    val line = built.rows.first()
                    val draft = SalesDraftEntity(
                        localId = dId,
                        customerLocalId = cid,
                        documentNumber = "${SalesDraft.TEMP_NUMBER_PREFIX}$dId",
                        vatExempt = true,
                        subtotal = totals.subtotal,
                        discountAmount = totals.discountAmount,
                        vatAmount = totals.vatAmount,
                        totalAmount = totals.finalAmount,
                        syncState = SyncState.DRAFT.wireValue,
                        createdAt = latest?.createdAt ?: now,
                        updatedAt = now,
                    )
                    val lines = listOf(
                        SalesDraftLineEntity(
                            localId = lineId,
                            draftLocalId = dId,
                            productLocalId = pid,
                            productName = productName.ifBlank { "کالا $pid" },
                            qty = line.qty,
                            unitPrice = line.unitPrice,
                            lineSum = line.sum,
                            variantColor = variantColor.ifBlank { null },
                            variantSize = variantSize.ifBlank { null },
                        ),
                    )
                    draftDao.saveDraftWithLines(draft, lines)
                    draftLocalId = dId
                    status = context.getString(R.string.cart_saved)
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.action_save_draft))
        }
        Button(
            onClick = {
                val cid = customerId.toLongOrNull() ?: return@Button
                val pid = productId.toLongOrNull() ?: return@Button
                val unit = price.toLongOrNull() ?: return@Button
                val provisionalId = draftLocalId ?: LocalIdAllocator.next(
                    1,
                    LocalIdAllocator.TABLE_INVOICES,
                    null,
                )
                val body = DraftOrderService.buildProformaBody(
                    DraftOrderService.ProformaRequest(
                        customerId = cid,
                        warehouseId = null,
                        note = null,
                        discountPercent = 0.0,
                        discountAmount = null,
                        vatExempt = true,
                        lines = listOf(LineBuilder.InputLine(productId = pid, qty = qty, unitPrice = unit)),
                        localDraftId = draftLocalId?.toString() ?: UUID.randomUUID().toString(),
                        provisionalInvoiceId = provisionalId,
                        userId = SessionRoles.userId,
                    ),
                )
                val built = LineBuilder.buildRows(listOf(LineBuilder.InputLine(pid, qty, unit)))
                val totals = VatCalculator.calcDocTotals(lines = LineBuilder.toVatLines(built), vatExempt = true)
                preview = "final=${totals.finalAmount}\npath=${DraftOrderService.PROFORMA_PATH}\n$body"
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.action_preview_proforma))
        }
        Spacer(Modifier = Modifier.height(8.dp))
        if (preview.isNotEmpty()) {
            Text(preview, style = MaterialTheme.typography.bodySmall)
        }
    }
}
