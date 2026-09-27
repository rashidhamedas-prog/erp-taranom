package ir.taranom.crm.sales.ui.screens

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.domain.DraftOrderService
import ir.taranom.crm.sales.core.domain.LineBuilder
import ir.taranom.crm.sales.core.domain.VatCalculator
import java.util.UUID

/**
 * Phase-1 cart / proforma preview — pure Compose, no WebView.
 * Persisting to Room + outbox is wired when SyncEngine lands.
 */
@Composable
fun CartOrderScreen() {
    var customerId by remember { mutableStateOf("1") }
    var productId by remember { mutableStateOf("1") }
    var qty by remember { mutableStateOf("1") }
    var price by remember { mutableStateOf("100000") }
    var preview by remember { mutableStateOf("") }

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
        Button(
            onClick = {
                val cid = customerId.toLongOrNull() ?: return@Button
                val pid = productId.toLongOrNull() ?: return@Button
                val unit = price.toLongOrNull() ?: return@Button
                val body = DraftOrderService.buildProformaBody(
                    DraftOrderService.ProformaRequest(
                        customerId = cid,
                        warehouseId = null,
                        note = null,
                        discountPercent = 0.0,
                        discountAmount = null,
                        vatExempt = true,
                        lines = listOf(
                            LineBuilder.InputLine(
                                productId = pid,
                                qty = qty,
                                unitPrice = unit,
                            ),
                        ),
                        localDraftId = UUID.randomUUID().toString(),
                    ),
                )
                val built = LineBuilder.buildRows(
                    listOf(LineBuilder.InputLine(pid, qty, unit)),
                )
                val totals = VatCalculator.calcDocTotals(
                    lines = LineBuilder.toVatLines(built),
                    vatExempt = true,
                )
                preview = "final=${totals.finalAmount}\n" +
                    "path=${DraftOrderService.PROFORMA_PATH}\n" +
                    body
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
