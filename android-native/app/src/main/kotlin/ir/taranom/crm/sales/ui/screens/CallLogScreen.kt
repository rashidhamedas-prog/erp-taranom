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
import ir.taranom.crm.sales.core.database.entity.CallLogEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.domain.CrmCaptureService
import ir.taranom.crm.sales.core.model.LocalIdAllocator
import ir.taranom.crm.sales.core.model.OutboxStatus
import ir.taranom.crm.sales.core.model.ProvisionalIds
import ir.taranom.crm.sales.core.model.SyncState
import ir.taranom.crm.sales.ui.session.SessionRoles
import kotlinx.coroutines.launch

/**
 * ثبت تماس — فقط مدت/نتیجه/یادداشت. **بدون ضبط صدا**.
 */
@Composable
fun CallLogScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val items by db.callLogDao().observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var customerId by remember { mutableStateOf("") }
    var date by remember { mutableStateOf("") }
    var duration by remember { mutableStateOf("0") }
    var outcome by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.nav_calls), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.calls_hint), style = MaterialTheme.typography.bodySmall)
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
            value = duration,
            onValueChange = { duration = it.filter(Char::isDigit) },
            label = { Text(stringResource(R.string.field_duration_min)) },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
        OutlinedTextField(
            value = outcome,
            onValueChange = { outcome = it },
            label = { Text(stringResource(R.string.field_outcome)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text(stringResource(R.string.field_note)) },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                val cid = customerId.toLongOrNull() ?: return@Button
                if (date.isBlank()) return@Button
                scope.launch {
                    val floor = ProvisionalIds.tableBase(1, LocalIdAllocator.TABLE_CALL_LOGS)
                    val id = LocalIdAllocator.next(1, LocalIdAllocator.TABLE_CALL_LOGS, db.callLogDao().maxProvisionalId(floor))
                    val now = System.currentTimeMillis()
                    val mins = duration.toIntOrNull() ?: 0
                    val entity = CallLogEntity(
                        localId = id,
                        repId = SessionRoles.repId,
                        customerLocalId = cid,
                        date = date,
                        durationMin = mins,
                        outcome = outcome.ifBlank { null },
                        note = note.ifBlank { null },
                        syncState = SyncState.PENDING_PUSH.wireValue,
                        createdAt = now,
                    )
                    val body = CrmCaptureService.buildCallBody(
                        customerId = cid,
                        date = date,
                        durationMin = mins,
                        outcome = outcome.ifBlank { null },
                        note = note.ifBlank { null },
                    )
                    val op = OutboxOpEntity(
                        method = CrmCaptureService.CALL_METHOD,
                        path = CrmCaptureService.callPath(SessionRoles.repId),
                        bodyJson = body,
                        userId = SessionRoles.userId,
                        status = OutboxStatus.PENDING.wireValue,
                        createdAt = now,
                    )
                    db.callLogDao().insertWithOutbox(entity, op)
                    note = ""
                    message = context.getString(R.string.saved_local_outbox)
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.action_save_call))
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(items, key = { it.localId }) { row ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("مشتری ${row.customerLocalId} · ${row.durationMin} دقیقه", style = MaterialTheme.typography.titleMedium)
                        Text("${row.date} · ${row.outcome.orEmpty()}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
