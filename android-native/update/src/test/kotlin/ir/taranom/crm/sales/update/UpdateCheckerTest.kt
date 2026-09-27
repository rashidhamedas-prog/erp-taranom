package ir.taranom.crm.sales.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {
    @Test
    fun detectsNewerVersionCode() {
        val manifest = ReleaseManifest(
            android = PlatformRelease(
                version = "3.0.1",
                versionCode = 101,
                url = "https://example.com/app.apk",
                sha256 = "a".repeat(64),
                distribution = "apk",
            ),
        )
        val r = UpdateChecker.check(manifest, "3.0.0-alpha01", 100)
        assertTrue(r.updateAvailable)
        assertTrue(r.downloadable)
    }

    @Test
    fun refusesDownloadWithoutSha256() {
        val manifest = ReleaseManifest(
            android = PlatformRelease(version = "9.0.0", versionCode = 999, url = "https://x/a.apk"),
        )
        val r = UpdateChecker.check(manifest, "1.0.0", 1)
        assertTrue(r.updateAvailable)
        assertFalse(r.downloadable)
        assertFalse(r.integrityValid)
    }
}
