package ir.taranom.crm.sales.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ir.taranom.crm.sales.R

@Composable
fun HelpGuideScreen() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.nav_help), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.help_intro), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.help_crm_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.help_crm_body), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.help_catalog_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.help_catalog_body), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.help_finance_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.help_finance_body), style = MaterialTheme.typography.bodyMedium)
        Text(stringResource(R.string.help_sync_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.help_sync_body), style = MaterialTheme.typography.bodyMedium)
    }
}
