package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import kotlinx.coroutines.launch

/**
 * مرور تعارض‌های پرچم‌خورده: outbox با status=conflict + جدول sync_conflicts.
 */
@Composable
fun ConflictReviewScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val outboxConflicts by db.outboxDao().observeConflicts().collectAsState(initial = emptyList())
    val pullConflicts by db.syncConflictDao().observeOpen().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.nav_conflicts), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.conflicts_hint), style = MaterialTheme.typography.bodySmall)

        Text(stringResource(R.string.conflicts_outbox_section), style = MaterialTheme.typography.titleMedium)
        if (outboxConflicts.isEmpty()) {
            Text(stringResource(R.string.conflicts_empty), style = MaterialTheme.typography.bodyMedium)
        }
        LazyColumn(
            modifier = Modifier.weight(1f, fill = false),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(outboxConflicts, key = { "o-${it.seq}" }) { op ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("#${op.seq} ${op.method} ${op.path}", style = MaterialTheme.typography.titleSmall)
                        Text(op.lastError ?: "—", style = MaterialTheme.typography.bodySmall)
                        Button(onClick = { scope.launch { db.outboxDao().discardConflict(op.seq) } }) {
                            Text(stringResource(R.string.action_discard_conflict))
                        }
                    }
                }
            }
        }

        Text(stringResource(R.string.conflicts_pull_section), style = MaterialTheme.typography.titleMedium)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(pullConflicts, key = { "p-${it.id}" }) { c ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("${c.entityTable} · ${c.message}", style = MaterialTheme.typography.bodyMedium)
                        Button(onClick = { scope.launch { db.syncConflictDao().markResolved(c.id) } }) {
                            Text(stringResource(R.string.action_resolve_conflict))
                        }
                    }
                }
            }
        }
    }
}
