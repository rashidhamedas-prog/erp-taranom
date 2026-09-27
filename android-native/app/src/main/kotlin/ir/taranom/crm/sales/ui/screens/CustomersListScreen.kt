package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import ir.taranom.crm.sales.core.database.entity.toDomain
import ir.taranom.crm.sales.core.model.Customer
import ir.taranom.crm.sales.ui.session.SessionRoles
import ir.taranom.crm.sales.ui.theme.TaranomSalesTheme

@Composable
fun CustomersListScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val rows by db.customerDao().observeScoped(SessionRoles.userId).collectAsState(initial = emptyList())
    val customers = rows.map { it.toDomain() }
    CustomersListContent(customers)
}

@Composable
fun CustomersListContent(customers: List<Customer>) {
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
                                text = listOfNotNull(customer.phone, customer.city).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }

        Text(
            text = stringResource(R.string.customers_room_note),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun CustomersListScreenPreview() {
    TaranomSalesTheme { CustomersListContent(emptyList()) }
}
