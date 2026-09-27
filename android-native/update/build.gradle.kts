import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

// منطق آپدیت امضاشده = Kotlin خالص تا بدون Android SDK روی JVM تست شود.
// دانلود/نصب PackageInstaller و WorkManager در ماژول :app سیم‌کشی می‌شوند.
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
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test.junit)
}
