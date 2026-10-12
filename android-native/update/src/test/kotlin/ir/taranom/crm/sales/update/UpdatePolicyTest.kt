package ir.taranom.crm.sales.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCompareTest {
    @Test
    fun comparesSemverLike() {
        assertTrue(VersionCompare.compare("2.0.32", "2.0.33") < 0)
        assertTrue(VersionCompare.compare("2.0.33", "2.0.33") == 0)
        assertTrue(VersionCompare.compare("3.0.0-alpha01", "2.0.33") > 0)
    }
}

class ManifestParserTest {
    @Test
    fun parsesAndroidBlock() {
        val json = """
            {
              "web": {"version": "2.1.8"},
              "android": {
                "version": "2.0.33",
                "versionCode": 35,
                "url": "/releases/erp-taranom.apk",
                "distribution": "server",
                "sha256": "E0EC3938A9BF0061557139EAD8EDAE026AE0251F4ACB0CAB5A0A1CDDB8645A02",
                "size": 69316805,
                "notes": "test"
              }
            }
        """.trimIndent()
        val m = ManifestParser.parse(json)
        assertEquals("2.0.33", m.android?.version)
        assertEquals(35L, m.android?.versionCode)
        assertEquals(69316805L, m.android?.size)
    }
}

class ApkUpdateEvaluatorTest {
    private val sampleSha = "e0ec3938a9bf0061557139ead8edae026ae0251f4acb0cab5a0a1cddb8645a02"

    @Test
    fun downloadableOnlyWhenHostAllowedAndIntegrityPresent() {
        val manifest = ReleaseManifest(
            android = PlatformRelease(
                version = "3.0.1",
                versionCode = 101,
                url = "https://erptaranom.com/releases/erp-taranom.apk",
                sha256 = sampleSha,
                size = 1000,
                distribution = "server",
            ),
        )
        val result = ApkUpdateEvaluator.evaluate(
            manifest = manifest,
            currentVersion = "3.0.0-alpha01",
            currentVersionCode = 100,
            baseUrl = "https://erptaranom.com",
        )
        assertTrue(result.updateAvailable)
        assertTrue(result.downloadable)
        assertTrue(ApkUpdateEvaluator.assertDownloadable(result).isSuccess)
    }

    @Test
    fun rejectsDisallowedHostEvenIfNewer() {
        val manifest = ReleaseManifest(
            android = PlatformRelease(
                version = "9.9.9",
                versionCode = 999,
                url = "https://evil.example/releases/x.apk",
                sha256 = sampleSha,
                size = 1000,
            ),
        )
        val result = ApkUpdateEvaluator.evaluate(
            manifest,
            currentVersion = "1.0.0",
            currentVersionCode = 1,
            baseUrl = "https://erptaranom.com",
        )
        assertTrue(result.updateAvailable)
        assertFalse(result.downloadable)
        assertTrue(ApkUpdateEvaluator.assertDownloadable(result).isFailure)
    }

    @Test
    fun resolvesRelativeUrlAgainstBase() {
        val resolved = UpdateHosts.resolveReleaseUrl(
            "/releases/erp-taranom.apk",
            "https://erptaranom.com",
        )
        assertEquals("https://erptaranom.com/releases/erp-taranom.apk", resolved)
        assertTrue(UpdateHosts.isAllowedApkUpdateUrl(resolved))
    }
}
