package ir.taranom.crm.sales.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

private val TaranomPurple = Color(0xFF5B3FA8)
private val TaranomPurpleLight = Color(0xFFD6CCF2)
private val TaranomGreen = Color(0xFF1F8A54)
private val TaranomAmber = Color(0xFFB8860B)

private val LightColors = lightColorScheme(
    primary = TaranomPurple,
    onPrimary = Color.White,
    primaryContainer = TaranomPurpleLight,
    onPrimaryContainer = Color(0xFF1E1035),
    secondary = TaranomGreen,
    onSecondary = Color.White,
    tertiary = TaranomAmber,
)

private val DarkColors = darkColorScheme(
    primary = TaranomPurpleLight,
    onPrimary = Color(0xFF1E1035),
    secondary = TaranomGreen,
    tertiary = TaranomAmber,
)

/**
 * تم محصول. جهت چیدمان **همیشه RTL** است — رابط فارسی است و نباید به locale
 * دستگاه فروشنده وابسته باشد (ADR-AND-001 §۱۱).
 */
@Composable
fun TaranomSalesTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = TaranomTypography,
            content = content,
        )
    }
}
