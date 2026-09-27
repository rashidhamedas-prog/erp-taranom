import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// ---------------------------------------------------------------------------
// اسرار امضا هرگز در گیت نیستند: از android-native/keystore.properties
// (در .gitignore) یا متغیرهای محیطی CRM_KEYSTORE_* خوانده می‌شوند.
// برخلاف legacy، **هیچ fallback امضای debug برای release وجود ندارد** —
// ADR-AND-001 §۴.۲ / §۱۰: «نبود کلید release ⇒ fail build کانال release».
// ---------------------------------------------------------------------------
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val ksFile: String? = keystoreProps.getProperty("storeFile") ?: System.getenv("CRM_KEYSTORE_FILE")
val ksPass: String? = keystoreProps.getProperty("storePassword") ?: System.getenv("CRM_KEYSTORE_PASSWORD")
val ksAlias: String? = keystoreProps.getProperty("keyAlias") ?: System.getenv("CRM_KEY_ALIAS")
val ksKeyPass: String? = keystoreProps.getProperty("keyPassword") ?: System.getenv("CRM_KEY_PASSWORD")
val hasReleaseSigning = !ksFile.isNullOrBlank() && !ksPass.isNullOrBlank() &&
        !ksAlias.isNullOrBlank() && !ksKeyPass.isNullOrBlank()

android {
    namespace = "ir.taranom.crm.sales"
    compileSdk = 36

    defaultConfig {
        // همان applicationId نسخهٔ legacy تا ارتقا بدون uninstall ممکن بماند (ADR A3).
        applicationId = "ir.taranom.crm"
        minSdk = 24
        targetSdk = 34
        // legacy روی versionCode 35 است؛ بومی از بالاتر شروع می‌کند تا مسیر
        // ارتقای in-place در فاز ۵ باز باشد.
        versionCode = 100
        versionName = "3.0.0-alpha01"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(ksFile!!)
                storePassword = ksPass
                keyAlias = ksAlias
                keyPassword = ksKeyPass
            }
        }
    }

    buildTypes {
        debug {
            // نصب کنار به کنار با APK قدیمی nodejs-mobile در طول توسعه.
            applicationIdSuffix = ".native.debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            // هیچ else‌ای اینجا نیست — گیت زیر build را fail می‌کند.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

// fail-closed: release بدون keystore ممنوع (نه APK بی‌امضا، نه debug-sign).
tasks.configureEach {
    if (name.endsWith("Release") &&
        (name.startsWith("assemble") || name.startsWith("bundle") || name.startsWith("package"))
    ) {
        doFirst {
            if (!hasReleaseSigning) {
                throw GradleException(
                    "کلید امضای release پیدا نشد. android-native/keystore.properties یا متغیرهای " +
                        "CRM_KEYSTORE_FILE / CRM_KEYSTORE_PASSWORD / CRM_KEY_ALIAS / CRM_KEY_PASSWORD را تنظیم کنید. " +
                        "fallback امضای debug برای کانال انتشار ممنوع است (ADR-AND-001)."
                )
            }
        }
    }
}

dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:domain"))
    implementation(project(":core:database"))
    implementation(project(":sync:api"))
    implementation(project(":migrate"))
    implementation(project(":update"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.work.runtime.ktx)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
}
