import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

// دامنهٔ فروش = Kotlin خالص. هیچ وابستگی اندروید/شبکه‌ای اضافه نشود تا
// fixtureهای parity روی JVM (و در CI بدون SDK) اجرا شوند.
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

    testImplementation(libs.kotlin.test.junit)
    testImplementation(libs.junit)
}
