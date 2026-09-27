package ir.taranom.crm.sales.ui.navigation

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.graphics.vector.ImageVector
import ir.taranom.crm.sales.R

/** مقصدهای فاز ۰. صفحات فروش (کاتالوگ، سبد، سند، وصول) در موج‌های بعد اضافه می‌شوند. */
enum class SalesDestination(
    val route: String,
    @StringRes val labelRes: Int,
    val icon: ImageVector,
    val inBottomBar: Boolean,
) {
    LoginLocal("login-local", R.string.nav_login, Icons.Filled.Lock, inBottomBar = false),
    CustomersList("customers", R.string.nav_customers, Icons.Filled.Person, inBottomBar = true),
    SyncStatus("sync-status", R.string.nav_sync, Icons.Filled.Refresh, inBottomBar = true),
    ;

    companion object {
        fun fromRoute(route: String?): SalesDestination? = entries.firstOrNull { it.route == route }
        val bottomBar: List<SalesDestination> = entries.filter { it.inBottomBar }
    }
}
