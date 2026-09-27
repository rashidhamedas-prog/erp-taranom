package ir.taranom.crm.sales.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.ui.navigation.SalesDestination

@Composable
fun MoreHubScreen(onOpen: (SalesDestination) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.nav_more), style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.more_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(SalesDestination.moreMenu, key = { it.route }) { dest ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpen(dest) },
                ) {
                    ListItem(
                        headlineContent = { Text(stringResource(dest.labelRes)) },
                        leadingContent = {
                            Icon(dest.icon, contentDescription = null)
                        },
                    )
                }
            }
        }
    }
}
