package ir.taranom.crm.sales.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.model.Customer
import ir.taranom.crm.sales.ui.theme.TaranomSalesTheme

/**
 * Placeholder فهرست مشتریان.
 *
 * فاز ۱: منبع داده = Room (`core:database`) با دامنهٔ مالکیت (`customer-scope`)؛
 * فیلتر نقش سمت داده انجام می‌شود، نه با مخفی‌کردن منو (ADR §۹).
 */
@Composable
fun CustomersListScreen(customers: List<Customer> = emptyList()) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = stringResource(R.string.customers_title),
            style = MaterialTheme.typography.headlineSmall,
        )

        if (customers.isEmpty()) {
            Text(
                text = stringResource(R.string.customers_empty),
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(customers, key = { it.localId }) { customer ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(customer.businessName, style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = customer.phone.orEmpty(),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }

        Text(
            text = stringResource(R.string.customers_placeholder_note),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun CustomersListScreenPreview() {
    TaranomSalesTheme { CustomersListScreen() }
}
