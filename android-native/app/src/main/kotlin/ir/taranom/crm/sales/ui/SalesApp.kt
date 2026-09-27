package ir.taranom.crm.sales.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ir.taranom.crm.sales.ui.navigation.SalesDestination
import ir.taranom.crm.sales.ui.screens.CallLogScreen
import ir.taranom.crm.sales.ui.screens.CartOrderScreen
import ir.taranom.crm.sales.ui.screens.CatalogScreen
import ir.taranom.crm.sales.ui.screens.ConflictReviewScreen
import ir.taranom.crm.sales.ui.screens.CustomersListScreen
import ir.taranom.crm.sales.ui.screens.FollowupsScreen
import ir.taranom.crm.sales.ui.screens.HelpGuideScreen
import ir.taranom.crm.sales.ui.screens.InvoiceListScreen
import ir.taranom.crm.sales.ui.screens.LoginLocalScreen
import ir.taranom.crm.sales.ui.screens.MoreHubScreen
import ir.taranom.crm.sales.ui.screens.PersonalReportsScreen
import ir.taranom.crm.sales.ui.screens.ReceiptScreen
import ir.taranom.crm.sales.ui.screens.ReturnScreen
import ir.taranom.crm.sales.ui.screens.SyncStatusScreen
import ir.taranom.crm.sales.ui.screens.VisitLogScreen
import ir.taranom.crm.sales.ui.session.SessionRoles

@Composable
fun SalesApp() {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val current = SalesDestination.fromRoute(backStackEntry?.destination?.route)

    Scaffold(
        bottomBar = {
            if (current?.inBottomBar == true) {
                NavigationBar {
                    SalesDestination.bottomBar.forEach { destination ->
                        NavigationBarItem(
                            selected = current == destination,
                            onClick = {
                                if (current != destination) {
                                    navController.navigate(destination.route) {
                                        launchSingleTop = true
                                        popUpTo(SalesDestination.CustomersList.route) {
                                            saveState = true
                                        }
                                        restoreState = true
                                    }
                                }
                            },
                            icon = {
                                Icon(
                                    imageVector = destination.icon,
                                    contentDescription = stringResource(destination.labelRes),
                                )
                            },
                            label = { Text(stringResource(destination.labelRes)) },
                        )
                    }
                }
            }
        },
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = SalesDestination.LoginLocal.route,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            composable(SalesDestination.LoginLocal.route) {
                LoginLocalScreen(
                    onSignedIn = {
                        SessionRoles.signIn(userId = 1L)
                        navController.navigate(SalesDestination.CustomersList.route) {
                            popUpTo(SalesDestination.LoginLocal.route) { inclusive = true }
                        }
                    },
                )
            }
            composable(SalesDestination.CustomersList.route) { CustomersListScreen() }
            composable(SalesDestination.Catalog.route) { CatalogScreen() }
            composable(SalesDestination.CartOrder.route) { CartOrderScreen() }
            composable(SalesDestination.More.route) {
                MoreHubScreen(
                    onOpen = { dest ->
                        navController.navigate(dest.route) { launchSingleTop = true }
                    },
                )
            }
            composable(SalesDestination.Followups.route) { FollowupsScreen() }
            composable(SalesDestination.VisitLog.route) { VisitLogScreen() }
            composable(SalesDestination.CallLog.route) { CallLogScreen() }
            composable(SalesDestination.Invoices.route) { InvoiceListScreen() }
            composable(SalesDestination.Returns.route) { ReturnScreen() }
            composable(SalesDestination.Receipts.route) { ReceiptScreen() }
            composable(SalesDestination.Conflicts.route) { ConflictReviewScreen() }
            composable(SalesDestination.Reports.route) { PersonalReportsScreen() }
            composable(SalesDestination.SyncStatus.route) { SyncStatusScreen() }
            composable(SalesDestination.Help.route) { HelpGuideScreen() }
        }
    }
}
