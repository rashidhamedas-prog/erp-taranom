package ir.taranom.crm.sales.ui.navigation

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.ui.graphics.vector.ImageVector
import ir.taranom.crm.sales.R

enum class SalesDestination(
    val route: String,
    @StringRes val labelRes: Int,
    val icon: ImageVector,
    val inBottomBar: Boolean,
) {
    LoginLocal("login-local", R.string.nav_login, Icons.Filled.Lock, inBottomBar = false),
    CustomersList("customers", R.string.nav_customers, Icons.Filled.Person, inBottomBar = true),
    Catalog("catalog", R.string.nav_catalog, Icons.Filled.Search, inBottomBar = true),
    CartOrder("cart", R.string.nav_cart, Icons.Filled.ShoppingCart, inBottomBar = true),
    More("more", R.string.nav_more, Icons.Filled.Menu, inBottomBar = true),
    Followups("followups", R.string.nav_followups, Icons.Filled.List, inBottomBar = false),
    VisitLog("visits", R.string.nav_visits, Icons.Filled.Place, inBottomBar = false),
    CallLog("calls", R.string.nav_calls, Icons.Filled.Phone, inBottomBar = false),
    Invoices("invoices", R.string.nav_invoices, Icons.Filled.Home, inBottomBar = false),
    Returns("returns", R.string.nav_returns, Icons.Filled.Refresh, inBottomBar = false),
    Receipts("receipts", R.string.nav_receipts, Icons.Filled.Star, inBottomBar = false),
    Conflicts("conflicts", R.string.nav_conflicts, Icons.Filled.Warning, inBottomBar = false),
    Reports("reports", R.string.nav_reports, Icons.Filled.Star, inBottomBar = false),
    SyncStatus("sync-status", R.string.nav_sync, Icons.Filled.Refresh, inBottomBar = false),
    Help("help", R.string.nav_help, Icons.Filled.Info, inBottomBar = false),
    ;

    companion object {
        fun fromRoute(route: String?): SalesDestination? = entries.firstOrNull { it.route == route }
        val bottomBar: List<SalesDestination> = entries.filter { it.inBottomBar }
        val moreMenu: List<SalesDestination> = listOf(
            Followups, VisitLog, CallLog, Invoices, Returns, Receipts,
            Conflicts, Reports, SyncStatus, Help,
        )
    }
}
