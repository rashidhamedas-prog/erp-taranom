pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        // آینه‌های aliyun مثل پروژهٔ legacy — دسترسی از ایران
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
    }
}

rootProject.name = "erp-taranom-sales-native"

include(":app")
include(":core:model")
include(":core:database")
include(":core:domain")
include(":sync:api")
include(":migrate")
include(":update")
// :sync:impl — جدا توسط ایجنت sync؛ تا commit آن ماژول، include نشود
