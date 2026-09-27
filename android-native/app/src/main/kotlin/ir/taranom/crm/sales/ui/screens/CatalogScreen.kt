package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import ir.taranom.crm.sales.core.database.entity.ProductEntity
import ir.taranom.crm.sales.core.database.entity.ProductVariantEntity

@Composable
fun CatalogScreen(onPickVariant: ((productId: Long, variant: ProductVariantEntity?) -> Unit)? = null) {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    var query by remember { mutableStateOf("") }
    val products by db.productDao().observeSearch(query.trim()).collectAsState(initial = emptyList())
    var pickerProduct by remember { mutableStateOf<ProductEntity?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.nav_catalog), style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.field_search_product)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        if (products.isEmpty()) {
            Text(stringResource(R.string.catalog_empty), style = MaterialTheme.typography.bodyMedium)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(products, key = { it.localId }) { product ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { pickerProduct = product },
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ProductImagePlaceholder()
                        Column(modifier = Modifier.weight(1f)) {
                            Text(product.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${product.code.orEmpty()} · ${product.priceRial} ریال",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }

    pickerProduct?.let { product ->
        VariantPickerDialog(
            product = product,
            onDismiss = { pickerProduct = null },
            onPick = { variant ->
                onPickVariant?.invoke(product.localId, variant)
                pickerProduct = null
            },
        )
    }
}

@Composable
fun ProductImagePlaceholder() {
    Box(
        modifier = Modifier
            .size(56.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.Star,
            contentDescription = stringResource(R.string.catalog_image_placeholder),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun VariantPickerDialog(
    product: ProductEntity,
    onDismiss: () -> Unit,
    onPick: (ProductVariantEntity?) -> Unit,
) {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val variants by db.productVariantDao().observeForProduct(product.localId)
        .collectAsState(initial = emptyList())

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.variant_picker_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(product.name, style = MaterialTheme.typography.titleSmall)
                if (variants.isEmpty()) {
                    Text(stringResource(R.string.variant_none), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { onPick(null) }) {
                        Text(stringResource(R.string.action_use_product_only))
                    }
                } else {
                    variants.forEach { v ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(v) },
                        ) {
                            Column(modifier = Modifier.padding(10.dp)) {
                                Text(
                                    listOfNotNull(v.colorName, v.sizeName).joinToString(" / ")
                                        .ifBlank { v.sku ?: "#${v.localId}" },
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Text("${v.priceRial} ریال · موجودی ${v.stock}", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_back)) }
        },
    )
}
