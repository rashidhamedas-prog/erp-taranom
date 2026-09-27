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
import ir.taranom.crm.sales.ui.screens.CustomersListScreen
import ir.taranom.crm.sales.ui.screens.LoginLocalScreen
import ir.taranom.crm.sales.ui.screens.SyncStatusScreen

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
                        navController.navigate(SalesDestination.CustomersList.route) {
                            popUpTo(SalesDestination.LoginLocal.route) { inclusive = true }
                        }
                    },
                )
            }
            composable(SalesDestination.CustomersList.route) {
                CustomersListScreen()
            }
            composable(SalesDestination.SyncStatus.route) {
                SyncStatusScreen()
            }
        }
    }
}
