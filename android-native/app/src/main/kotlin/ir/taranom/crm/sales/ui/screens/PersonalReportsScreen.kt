package ir.taranom.crm.sales.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import ir.taranom.crm.sales.core.domain.LocalReports
import ir.taranom.crm.sales.ui.session.SessionRoles

@Composable
fun PersonalReportsScreen() {
    val context = LocalContext.current
    val db = remember { TaranomDatabaseProvider.get(context.applicationContext as Application) }
    val customers by db.customerDao().observeScoped(SessionRoles.userId).collectAsState(initial = emptyList())
    val openFollowups by db.followupDao().observeOpenCount().collectAsState(initial = 0)
    val visits by db.visitLogDao().observeCount().collectAsState(initial = 0)
    val calls by db.callLogDao().observeCount().collectAsState(initial = 0)
    val drafts by db.salesDraftDao().observeOpenCount().collectAsState(initial = 0)
    val invoices by db.invoiceDao().observeCount().collectAsState(initial = 0)
    val receiptTotal by db.receiptDao().observeTotalAmount().collectAsState(initial = 0L)
    val pending by db.outboxDao().observePendingCount().collectAsState(initial = 0)
    val conflicts by db.outboxDao().observeConflictCount().collectAsState(initial = 0)

    val snap = LocalReports.snapshot(
        customerCount = customers.size,
        openFollowups = openFollowups,
        visitCount = visits,
        callCount = calls,
        draftCount = drafts,
        invoiceCount = invoices,
        receiptTotalRial = receiptTotal,
        pendingOutbox = pending,
        conflictOutbox = conflicts,
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.nav_reports), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.reports_hint), style = MaterialTheme.typography.bodySmall)
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ReportRow(stringResource(R.string.report_customers), snap.customerCount.toString())
                ReportRow(stringResource(R.string.report_followups), snap.openFollowups.toString())
                ReportRow(stringResource(R.string.report_visits), snap.visitCount.toString())
                ReportRow(stringResource(R.string.report_calls), snap.callCount.toString())
                ReportRow(stringResource(R.string.report_drafts), snap.draftCount.toString())
                ReportRow(stringResource(R.string.report_invoices), snap.invoiceCount.toString())
                ReportRow(stringResource(R.string.report_receipts_total), "${snap.receiptTotalRial}")
                ReportRow(stringResource(R.string.report_pending), snap.pendingOutbox.toString())
                ReportRow(stringResource(R.string.report_conflicts), snap.conflictOutbox.toString())
            }
        }
    }
}

@Composable
private fun ReportRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.titleMedium)
    }
}
