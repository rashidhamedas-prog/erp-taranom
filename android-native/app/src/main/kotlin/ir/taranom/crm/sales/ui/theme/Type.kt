package ir.taranom.crm.sales.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily

/**
 * TODO(فاز ۱): فونت وزیرمتن به‌صورت فایل داخل APK اضافه شود (ADR §۱۱ — بدون CDN).
 * تا آن زمان فونت سیستم استفاده می‌شود؛ هیچ فونت باینری در این کامیت نیست.
 */
private val TaranomFontFamily = FontFamily.Default

private val base = Typography()

private fun TextStyle.fa() = copy(fontFamily = TaranomFontFamily)

val TaranomTypography = Typography(
    displayLarge = base.displayLarge.fa(),
    displayMedium = base.displayMedium.fa(),
    displaySmall = base.displaySmall.fa(),
    headlineLarge = base.headlineLarge.fa(),
    headlineMedium = base.headlineMedium.fa(),
    headlineSmall = base.headlineSmall.fa(),
    titleLarge = base.titleLarge.fa(),
    titleMedium = base.titleMedium.fa(),
    titleSmall = base.titleSmall.fa(),
    bodyLarge = base.bodyLarge.fa(),
    bodyMedium = base.bodyMedium.fa(),
    bodySmall = base.bodySmall.fa(),
    labelLarge = base.labelLarge.fa(),
    labelMedium = base.labelMedium.fa(),
    labelSmall = base.labelSmall.fa(),
)
