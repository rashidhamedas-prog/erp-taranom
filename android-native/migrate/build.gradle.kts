import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

// Migrator + بکاپ امن = Kotlin خالص. باز کردن فایل SQLite legacy از طریق
// رابط LegacySqliteSource انجام می‌شود تا تست JVM بدون android.database بماند؛
// پیاده‌سازی اندرویدی در :app است.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":core:model"))

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test.junit)
}
