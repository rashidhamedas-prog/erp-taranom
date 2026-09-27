import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

// فقط قرارداد (interface + مدل نتیجه). هیچ کلاینت HTTP اینجا اضافه نشود تا
// پیاده‌سازی در `sync:impl` فاز ۱ جدا و قابل جایگزینی/تست بماند.
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
}
