package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
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
import ir.taranom.crm.sales.ui.theme.TaranomSalesTheme

@Composable
fun SyncStatusScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val pending by db.outboxDao().observePendingCount().collectAsState(initial = 0)
    val conflicts by db.outboxDao().observeConflictCount().collectAsState(initial = 0)
    SyncStatusContent(pendingOps = pending, conflictOps = conflicts, lastPullLabel = null)
}

@Composable
fun SyncStatusContent(
    pendingOps: Int = 0,
    conflictOps: Int = 0,
    lastPullLabel: String? = null,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = stringResource(R.string.sync_title),
            style = MaterialTheme.typography.headlineSmall,
        )

        AssistChip(
            onClick = {},
            label = { Text(stringResource(R.string.sync_state_offline)) },
        )

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                StatusRow(
                    label = stringResource(R.string.sync_pending_label),
                    value = pendingOps.toString(),
                )
                StatusRow(
                    label = stringResource(R.string.sync_conflicts_label),
                    value = conflictOps.toString(),
                )
                StatusRow(
                    label = stringResource(R.string.sync_last_pull_label),
                    value = lastPullLabel ?: stringResource(R.string.sync_never),
                )
            }
        }

        Text(
            text = stringResource(R.string.sync_placeholder_note),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

@Composable
private fun StatusRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.titleMedium)
    }
}

@Preview(showBackground = true)
@Composable
private fun SyncStatusScreenPreview() {
    TaranomSalesTheme { SyncStatusContent(pendingOps = 3, conflictOps = 1) }
}
