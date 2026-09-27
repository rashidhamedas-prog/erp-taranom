package ir.taranom.crm.sales.ui.screens

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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.ui.theme.TaranomSalesTheme

/**
 * Placeholder وضعیت همگام‌سازی.
 *
 * فاز ۱: شمارش واقعی صف از `outbox_ops` + تفکیک صریح حالت‌ها. «آفلاین» هرگز با
 * «توکن منقضی» یکی نمایش داده نمی‌شود (ADR §۸.۲).
 */
@Composable
fun SyncStatusScreen(
    pendingOps: Int = 0,
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
    TaranomSalesTheme { SyncStatusScreen(pendingOps = 3) }
}
