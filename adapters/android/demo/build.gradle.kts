plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.xp.demo"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.xp.demo"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        buildConfigField("String", "XP_URL", "\"${providers.gradleProperty("xpUrl").getOrElse("http://10.0.2.2:4400")}\"")
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].java.srcDirs("src/main/kotlin")
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":xp-android"))
    implementation(platform("androidx.compose:compose-bom:2025.06.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.10.1")
}
