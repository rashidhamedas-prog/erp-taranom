package ir.taranom.crm.sales

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import ir.taranom.crm.sales.ui.SalesApp
import ir.taranom.crm.sales.ui.theme.TaranomSalesTheme

/**
 * تنها Activity محصول — رابط کاربری کامل Compose است.
 *
 * هیچ WebView‌ای در مسیرهای اصلی فروش وجود ندارد و اضافه نمی‌شود؛ محصول legacy
 * (`android/`) که WebView روی `http://127.0.0.1:3210` بود اینجا بازتولید نمی‌شود
 * (ADR-AND-001 §۰ و §۱.۲).
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            TaranomSalesTheme {
                SalesApp()
            }
        }
    }
}
