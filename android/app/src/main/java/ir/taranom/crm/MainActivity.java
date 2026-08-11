package ir.taranom.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import org.json.JSONObject;

/**
 * ERP Taranom — offline Android app.
 *
 * Boots an embedded Node.js runtime (nodejs-mobile) running the exact same
 * Express/SQLite backend as the central server, with SYNC_ROLE=device.
 */
public class MainActivity extends Activity {

    private static final String TAG = "ERPTaranom";
    private static final int LOCAL_PORT = 3210;
    private static final String LOCAL_URL = "http://127.0.0.1:" + LOCAL_PORT + "/";
    private static final String UPDATE_CHANNEL_ID = "erp_updates";
    private static final int REQ_POST_NOTIFICATIONS = 4401;
    private static final long MAX_APK_SIZE_BYTES = 512L * 1024L * 1024L;
    private static final String APK_PREFS = "verified_apk_download";
    private static final Set<String> APK_UPDATE_HOSTS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("erp.poshaktaranom.com", "poshaktaranom.com")));
    private static int updateNotifId = 7100;

    /** JNI bridge implemented in cpp/native-lib.cpp */
    public native Integer startNodeWithArguments(String[] arguments);

    /** Re-dlopen libnode with RTLD_GLOBAL so better-sqlite3 can resolve V8 symbols. */
    public native void promoteNodeSymbols();

    /** Absolute-path dlopen of libnode + libbetter_sqlite3 in the app linker namespace. */
    public native void preloadSqliteNative(String nativeLibDir);

    private WebView webView;
    private volatile boolean nodeLaunchRequested = false;
    private File dataDir;
    private boolean nativeReady = false;
    private final Set<Long> activeApkDownloads = Collections.synchronizedSet(new HashSet<>());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> {
            Log.e(TAG, "Uncaught on " + thread.getName(), ex);
            showErrorPage("خطای غیرمنتظره در راه‌اندازی",
                    ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName());
        });

        try {
            webView = new WebView(this);
            WebSettings ws = webView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setDatabaseEnabled(true);
            ws.setAllowFileAccess(false);
            ws.setAllowContentAccess(false);
            ws.setAllowFileAccessFromFileURLs(false);
            ws.setAllowUniversalAccessFromFileURLs(false);
            ws.setSupportMultipleWindows(false);
            ws.setLoadsImagesAutomatically(true);
            ws.setBlockNetworkImage(false);
            ws.setCacheMode(WebSettings.LOAD_DEFAULT);
            ws.setUseWideViewPort(true);
            ws.setLoadWithOverviewMode(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ws.setSafeBrowsingEnabled(true);
            }
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
            ws.setUserAgentString(ws.getUserAgentString() + " ERPTaranomAndroid/" + BuildConfig.VERSION_NAME);

            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage msg) {
                    if (BuildConfig.DEBUG) {
                        Log.d(TAG, "JS console message at line " + msg.lineNumber());
                    }
                    return true;
                }
            });

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri target = request != null ? request.getUrl() : null;
                    return target == null || !"http".equals(target.getScheme())
                            || !"127.0.0.1".equals(target.getHost()) || target.getPort() != LOCAL_PORT;
                }
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request == null || !request.isForMainFrame()) return;
                    CharSequence desc = error != null ? error.getDescription() : "unknown";
                    Log.e(TAG, "WebView main frame error: " + desc);
                    showErrorPage("خطا در بارگذاری رابط برنامه",
                            desc.toString() + "\n\n" + readBootLogTail());
                }
            });

            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                    handleUnstructuredWebDownload(url, contentDisposition, mimeType));
            ensureUpdateNotificationChannel();
            requestNotificationPermissionIfNeeded();
            webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
            setContentView(webView);
            warnIfRiskyEnvironment();
            resumePendingApkDownload();
        } catch (Exception e) {
            Log.e(TAG, "WebView init failed", e);
            showErrorPage("خطا در بارگذاری رابط برنامه", e.getMessage());
            return;
        }

        // Load natives after WebView exists so UnsatisfiedLinkError shows our page
        // instead of the system "Something went wrong" dialog (common on Android 15+
        // 16KB-page devices when libnode is still 4KB-aligned).
        try {
            System.loadLibrary("c++_shared");
            System.loadLibrary("node");
            System.loadLibrary("native-lib");
            String nativeLibDir = getApplicationInfo().nativeLibraryDir;
            try {
                promoteNodeSymbols();
            } catch (UnsatisfiedLinkError e) {
                Log.w(TAG, "promoteNodeSymbols unavailable", e);
            }
            try {
                preloadSqliteNative(nativeLibDir != null ? nativeLibDir : "");
            } catch (UnsatisfiedLinkError e) {
                Log.w(TAG, "preloadSqliteNative unavailable", e);
            }
            try {
                // Absolute path: resolves DT_NEEDED=libnode.so against sibling jniLibs.
                if (nativeLibDir != null) {
                    File sqliteSo = new File(nativeLibDir, "libbetter_sqlite3.so");
                    if (sqliteSo.isFile()) {
                        System.load(sqliteSo.getAbsolutePath());
                        Log.i(TAG, "System.load better_sqlite3 ok: " + sqliteSo.getAbsolutePath());
                    } else {
                        System.loadLibrary("better_sqlite3");
                    }
                } else {
                    System.loadLibrary("better_sqlite3");
                }
            } catch (UnsatisfiedLinkError e) {
                Log.e(TAG, "libbetter_sqlite3 preload failed", e);
            }
            nativeReady = true;
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Native library load failed", e);
            showErrorPage("کتابخانهٔ داخلی بارگذاری نشد",
                    (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName())
                            + "\n\nنسخهٔ ۲.۰.۱۹ به‌بعد را نصب کنید."
                            + "\nاپ قبلی را حذف و APK جدید را دوباره نصب کنید.");
            return;
        }

        dataDir = new File(getApplicationContext().getFilesDir(), "crm-data");
        //noinspection ResultOfMethodCallIgnored
        dataDir.mkdirs();

        showSplash("در حال آماده‌سازی برنامه...", "اولین اجرا ممکن است ۲–۵ دقیقه طول بکشد — برنامه را نبندید.");
        startBootPipeline();
    }

    private void startBootPipeline() {
        new Thread(() -> {
            try {
                final Context ctx = getApplicationContext();
                File projectDir = new File(ctx.getFilesDir(), "nodejs-project");
                boolean needsExtract = assetsWereUpdated(ctx) || !projectIsValid(projectDir);
                if (needsExtract) {
                    Log.i(TAG, "Extracting bundled Node project...");
                    showSplash("در حال استخراج فایل‌های برنامه...", "لطفاً صبر کنید — این مرحله فقط یک‌بار طول می‌کشد.");
                    deleteRecursive(projectDir);
                    copyAssetFolderSafe(ctx.getAssets(), "nodejs-project", projectDir.getAbsolutePath(),
                            count -> showSplash("در حال استخراج فایل‌های برنامه...",
                                    "فایل‌های کپی‌شده: " + count + " — برنامه را نبندید."));
                    if (!projectIsValid(projectDir)) {
                        throw new IllegalStateException("استخراج ناقص — main.js یا وابستگی‌ها یافت نشد");
                    }
                    saveAssetStamp(ctx);
                    Log.i(TAG, "Asset extraction complete");
                }

                showSplash("در حال راه‌اندازی سرور داخلی...", "چند لحظه صبر کنید...");
                launchNodeServer(projectDir);
            } catch (Throwable t) {
                Log.e(TAG, "Boot pipeline failed", t);
                showErrorPage("خطا در آماده‌سازی برنامه",
                        (t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName())
                                + "\n\n" + readBootLogTail());
            }
        }, "crm-boot").start();

        loadWhenReady();
    }

    private void launchNodeServer(File projectDir) {
        if (!nativeReady) {
            throw new IllegalStateException("native libraries not loaded");
        }
        File mainJs = new File(projectDir, "main.js");
        if (!mainJs.isFile()) {
            throw new IllegalStateException("main.js missing");
        }
        File ready = new File(dataDir, "server.ready");
        //noinspection ResultOfMethodCallIgnored
        ready.delete();

        synchronized (MainActivity.class) {
            if (nodeLaunchRequested) return;
            nodeLaunchRequested = true;
        }

        Log.i(TAG, "Starting embedded Node server...");
        final String nativeLibDir = getApplicationInfo().nativeLibraryDir;
        new Thread(() -> {
            String[] nodeArguments = null;
            try {
                String jwtSecret = SecureSecretStore.getOrCreateJwtSecret(
                        getApplicationContext(), dataDir);
                nodeArguments = new String[]{
                        "node",
                        mainJs.getAbsolutePath(),
                        dataDir.getAbsolutePath(),
                        String.valueOf(LOCAL_PORT),
                        nativeLibDir != null ? nativeLibDir : "",
                        jwtSecret
                };
                jwtSecret = null;
                Integer code = startNodeWithArguments(nodeArguments);
                Log.w(TAG, "Node runtime returned code=" + code);
                nodeLaunchRequested = false;
                showErrorPage("سرور داخلی متوقف شد",
                        "کد خروج: " + code + "\n\n" + readBootLogTail());
            } catch (Throwable t) {
                Log.e(TAG, "Node runtime exited", t);
                nodeLaunchRequested = false;
                showErrorPage("سرور داخلی متوقف شد",
                        (t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName())
                                + "\n\n" + readBootLogTail());
            } finally {
                if (nodeArguments != null) Arrays.fill(nodeArguments, "[REDACTED]");
            }
        }, "crm-node").start();
    }

    private void showSplash(String title, String detail) {
        String safeTitle = htmlEscape(title != null ? title : "ERP ترنم");
        String safeDetail = htmlEscape(detail != null ? detail : "");
        String html = "<html dir='rtl'><body style='display:flex;align-items:center;justify-content:center;height:96vh;margin:0;font-family:sans-serif;background:#0D1512;color:#E8F1EB'>"
                + "<div style='text-align:center;max-width:90%;padding:16px'>"
                + "<div style='font-size:52px'>🌿</div>"
                + "<h2 style='margin:8px 0'>ERP ترنم</h2>"
                + "<p style='color:#7F978A;line-height:1.9;font-size:15px'>" + safeTitle + "<br>" + safeDetail + "</p>"
                + "</div></body></html>";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
        });
    }

    private void showErrorPage(String title, String detail) {
        String safeTitle = htmlEscape(title != null ? title : "خطا");
        String safeDetail = htmlEscape(detail != null ? detail : "");
        String html = "<html dir='rtl'><body style='font-family:sans-serif;padding:24px;background:#0D1512;color:#E8F1EB'>"
                + "<h3 style='text-align:center'>" + safeTitle + "</h3>"
                + "<pre style='color:#7F978A;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;background:#111916;padding:12px;border-radius:8px'>"
                + safeDetail + "</pre>"
                + "<p style='color:#7F978A;text-align:center;line-height:1.8'>برنامه را از لیست برنامه‌های اخیر کامل ببندید و دوباره باز کنید.<br>"
                + "اگر تکرار شد، نسخه قبلی را حذف و آخرین APK را دوباره نصب کنید.</p></body></html>";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
        });
    }

    private String readBootLogTail() {
        try {
            File log = new File(dataDir, "boot.log");
            if (!log.isFile() || log.length() == 0) return "";
            StringBuilder sb = new StringBuilder();
            sb.append("─── boot.log ───\n");
            try (BufferedReader br = new BufferedReader(new InputStreamReader(
                    new FileInputStream(log), StandardCharsets.UTF_8))) {
                ArrayDeque<String> lines = new ArrayDeque<>();
                String line;
                while ((line = br.readLine()) != null) {
                    lines.addLast(line);
                    while (lines.size() > 40) lines.removeFirst();
                }
                for (String l : lines) sb.append(l).append('\n');
            }
            return sb.toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    private static String htmlEscape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private boolean serverReady() {
        File ready = new File(dataDir, "server.ready");
        if (!ready.isFile() || ready.length() == 0) return false;
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + LOCAL_PORT + "/api/system/health").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean serverFailed() {
        File fail = new File(dataDir, "server.fail");
        return fail.isFile() && fail.length() > 0;
    }

    private String readFailMessage() {
        try {
            File fail = new File(dataDir, "server.fail");
            if (!fail.isFile()) return "";
            byte[] buf = new byte[(int) Math.min(fail.length(), 4000)];
            try (FileInputStream in = new FileInputStream(fail)) {
                int n = in.read(buf);
                return n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
            }
        } catch (Exception e) {
            return "";
        }
    }

    private void loadWhenReady() {
        new Thread(() -> {
            for (int i = 0; i < 600; i++) {
                if (serverReady()) {
                    runOnUiThread(() -> {
                        if (webView != null) webView.loadUrl(LOCAL_URL);
                    });
                    return;
                }
                if (serverFailed()) {
                    showErrorPage("خطا در راه‌اندازی سرور داخلی",
                            readFailMessage() + "\n\n" + readBootLogTail());
                    return;
                }
                if (i > 0 && i % 15 == 0) {
                    showSplash("در حال راه‌اندازی سرور داخلی...",
                            "هنوز در حال آماده‌سازی (" + (i / 60) + " دقیقه) — برنامه را نبندید.");
                }
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
            showErrorPage("خطا در راه‌اندازی سرور داخلی",
                    "پس از ۱۰ دقیقه پاسخی از سرور داخلی دریافت نشد.\n\n" + readBootLogTail());
        }, "crm-poll").start();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    private void handleUnstructuredWebDownload(String url, String contentDisposition, String mimeType) {
        boolean isApk = "application/vnd.android.package-archive".equalsIgnoreCase(mimeType)
                || (url != null && url.toLowerCase(Locale.ROOT).split("[?#]", 2)[0].endsWith(".apk"));
        if (isApk) {
            Log.w(TAG, "Blocked APK download without verified metadata");
            postApkProgress(0, 0, "failed");
            Toast.makeText(this, "دانلود APK بدون هش و اندازه معتبر مسدود شد.", Toast.LENGTH_LONG).show();
            return;
        }
        if (!isAllowedRegularDownloadUrl(url)) {
            Log.w(TAG, "Blocked non-allowlisted WebView download");
            Toast.makeText(this, "آدرس دانلود مجاز نیست.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            String guessed = URLUtil.guessFileName(url, contentDisposition, mimeType);
            String fileName = new File(guessed != null ? guessed : "download").getName();
            if (fileName.isEmpty()) fileName = "download";
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("download service unavailable");
            dm.enqueue(request);
        } catch (Exception e) {
            Log.w(TAG, "WebView download rejected: " + e.getClass().getSimpleName());
            Toast.makeText(this, "شروع دانلود ممکن نشد.", Toast.LENGTH_LONG).show();
        }
    }

    private static boolean isAllowedRegularDownloadUrl(String value) {
        try {
            java.net.URI uri = new java.net.URI(value);
            if (uri.getUserInfo() != null || uri.getFragment() != null) return false;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if ("http".equalsIgnoreCase(uri.getScheme())) {
                return "127.0.0.1".equals(host) && uri.getPort() == LOCAL_PORT;
            }
            return "https".equalsIgnoreCase(uri.getScheme())
                    && (uri.getPort() == -1 || uri.getPort() == 443)
                    && APK_UPDATE_HOSTS.contains(host);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isAllowedApkUpdateUrl(String value) {
        try {
            if (value == null || value.length() > 2048) return false;
            java.net.URI uri = new java.net.URI(value);
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            String path = uri.getPath() != null ? uri.getPath().toLowerCase(Locale.ROOT) : "";
            return "https".equalsIgnoreCase(uri.getScheme())
                    && (uri.getPort() == -1 || uri.getPort() == 443)
                    && uri.getUserInfo() == null
                    && uri.getFragment() == null
                    && APK_UPDATE_HOSTS.contains(host)
                    && path.endsWith(".apk");
        } catch (Exception e) {
            return false;
        }
    }

    private String beginVerifiedApkDownload(String url, String expectedSha256, long expectedSize) {
        String sha256 = expectedSha256 != null
                ? expectedSha256.trim().toLowerCase(Locale.ROOT) : "";
        if (!isAllowedApkUpdateUrl(url)) return apkBridgeResult(false, -1, "url_not_allowed");
        if (!sha256.matches("^[0-9a-f]{64}$")) return apkBridgeResult(false, -1, "invalid_sha256");
        if (expectedSize <= 0 || expectedSize > MAX_APK_SIZE_BYTES) {
            return apkBridgeResult(false, -1, "invalid_size");
        }

        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        if (dm == null) return apkBridgeResult(false, -1, "download_service_unavailable");
        long id = -1;
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType("application/vnd.android.package-archive");
            request.setTitle("ERP Taranom update");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            request.setDestinationInExternalFilesDir(
                    this,
                    Environment.DIRECTORY_DOWNLOADS,
                    "erp-taranom-update-" + System.currentTimeMillis() + ".apk");
            id = dm.enqueue(request);
            if (!persistPendingApk(id, sha256, expectedSize)) {
                dm.remove(id);
                return apkBridgeResult(false, -1, "metadata_persist_failed");
            }
            trackVerifiedApkDownload(dm, id, sha256, expectedSize);
            return apkBridgeResult(true, id, null);
        } catch (Exception e) {
            if (id >= 0) dm.remove(id);
            Log.w(TAG, "Verified APK download start failed: " + e.getClass().getSimpleName());
            return apkBridgeResult(false, -1, "enqueue_failed");
        }
    }

    private static String apkBridgeResult(boolean accepted, long id, String error) {
        try {
            JSONObject out = new JSONObject();
            out.put("accepted", accepted);
            if (id >= 0) out.put("downloadId", id);
            if (error != null) out.put("error", error);
            return out.toString();
        } catch (Exception e) {
            return accepted ? "{\"accepted\":true}" : "{\"accepted\":false}";
        }
    }

    private boolean persistPendingApk(long id, String sha256, long size) {
        return getSharedPreferences(APK_PREFS, MODE_PRIVATE).edit()
                .putLong("id", id)
                .putString("sha256", sha256)
                .putLong("size", size)
                .commit();
    }

    private void clearPendingApk(long id) {
        SharedPreferences prefs = getSharedPreferences(APK_PREFS, MODE_PRIVATE);
        if (prefs.getLong("id", -1) == id) prefs.edit().clear().commit();
    }

    private void resumePendingApkDownload() {
        SharedPreferences prefs = getSharedPreferences(APK_PREFS, MODE_PRIVATE);
        long id = prefs.getLong("id", -1);
        String sha256 = prefs.getString("sha256", "");
        long size = prefs.getLong("size", -1);
        if (id < 0) return;
        if (sha256 == null || !sha256.matches("^[0-9a-f]{64}$")
                || size <= 0 || size > MAX_APK_SIZE_BYTES) {
            clearPendingApk(id);
            return;
        }
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        if (dm != null) trackVerifiedApkDownload(dm, id, sha256, size);
    }

    private void trackVerifiedApkDownload(
            final DownloadManager dm,
            final long id,
            final String expectedSha256,
            final long expectedSize) {
        if (!activeApkDownloads.add(id)) return;
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.post(new Runnable() {
            private int missingPolls = 0;

            @Override
            public void run() {
                long done = 0;
                long total = -1;
                int status = DownloadManager.STATUS_PENDING;
                boolean found = false;
                DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                try (android.database.Cursor cursor = dm.query(query)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        found = true;
                        done = cursor.getLong(cursor.getColumnIndexOrThrow(
                                DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        total = cursor.getLong(cursor.getColumnIndexOrThrow(
                                DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        status = cursor.getInt(cursor.getColumnIndexOrThrow(
                                DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "APK download query failed: " + e.getClass().getSimpleName());
                }

                if (!found) {
                    missingPolls++;
                    if (missingPolls >= 3) {
                        rejectApkDownload(dm, id, "download_missing");
                        return;
                    }
                    handler.postDelayed(this, 750);
                    return;
                }
                if (done > expectedSize || (total > 0 && total != expectedSize)) {
                    rejectApkDownload(dm, id, "size_mismatch");
                    return;
                }
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    activeApkDownloads.remove(id);
                    postApkProgress(done, expectedSize, "verifying");
                    new Thread(() -> verifyAndInstallApk(dm, id, expectedSha256, expectedSize),
                            "crm-apk-verify").start();
                    return;
                }
                if (status == DownloadManager.STATUS_FAILED) {
                    rejectApkDownload(dm, id, "download_failed");
                    return;
                }
                postApkProgress(Math.max(0, done), expectedSize, "downloading");
                handler.postDelayed(this, 750);
            }
        });
    }

    private void verifyAndInstallApk(
            DownloadManager dm, long id, String expectedSha256, long expectedSize) {
        Uri apkUri = dm.getUriForDownloadedFile(id);
        if (apkUri == null) {
            rejectApkDownload(dm, id, "download_uri_missing");
            return;
        }
        try {
            File apkFile = resolveDownloadedApkFile(dm, id);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            long actualSize = 0;
            int read;
            try (InputStream input = new FileInputStream(apkFile)) {
                while ((read = input.read(buffer)) != -1) {
                    actualSize += read;
                    if (actualSize > expectedSize) {
                        rejectApkDownload(dm, id, "size_mismatch");
                        return;
                    }
                    digest.update(buffer, 0, read);
                }
            }
            byte[] expectedHash = hexToBytes(expectedSha256);
            boolean sizeMatches = actualSize == expectedSize;
            boolean hashMatches = MessageDigest.isEqual(expectedHash, digest.digest());
            if (!sizeMatches || !hashMatches) {
                rejectApkDownload(dm, id, sizeMatches ? "sha256_mismatch" : "size_mismatch");
                return;
            }

            String identityFailure = verifyApkIdentityAndSigner(apkFile);
            if (identityFailure != null) {
                rejectApkDownload(dm, id, identityFailure);
                return;
            }

            clearPendingApk(id);
            postApkProgress(actualSize, expectedSize, "done");
            runOnUiThread(() -> launchVerifiedApkInstaller(apkUri, dm, id));
        } catch (Exception e) {
            Log.w(TAG, "APK verification failed: " + e.getClass().getSimpleName());
            rejectApkDownload(dm, id, "verification_failed");
        }
    }

    private File resolveDownloadedApkFile(DownloadManager dm, long id) throws Exception {
        String localUri = null;
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (android.database.Cursor cursor = dm.query(query)) {
            if (cursor != null && cursor.moveToFirst()) {
                localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
            }
        }
        if (localUri == null) throw new SecurityException("download local path missing");
        Uri parsed = Uri.parse(localUri);
        if (!"file".equalsIgnoreCase(parsed.getScheme()) || parsed.getPath() == null) {
            throw new SecurityException("download local path invalid");
        }
        File file = new File(parsed.getPath()).getCanonicalFile();
        File allowedRoot = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (allowedRoot == null) throw new IOException("download directory unavailable");
        String rootPath = allowedRoot.getCanonicalPath() + File.separator;
        if (!file.getPath().startsWith(rootPath) || !file.isFile()) {
            throw new SecurityException("download path escaped app directory");
        }
        return file;
    }

    @SuppressWarnings("deprecation")
    private String verifyApkIdentityAndSigner(File apkFile) throws Exception {
        PackageManager packageManager = getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo archive = packageManager.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        PackageInfo installed = packageManager.getPackageInfo(getPackageName(), flags);
        if (archive == null || installed == null) return "apk_metadata_invalid";
        if (!BuildConfig.APPLICATION_ID.equals(archive.packageName)
                || !getPackageName().equals(archive.packageName)) {
            return "package_name_mismatch";
        }
        if (getLongVersionCode(archive) <= getLongVersionCode(installed)) {
            return "version_not_newer";
        }
        Set<String> archiveSigners = signerDigests(archive);
        Set<String> installedSigners = signerDigests(installed);
        if (archiveSigners.isEmpty() || !archiveSigners.equals(installedSigners)) {
            return "signer_mismatch";
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static long getLongVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signerDigests(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            if (info.signingInfo == null) return Collections.emptySet();
            signatures = info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) return Collections.emptySet();
        Set<String> digests = new HashSet<>();
        for (Signature signature : signatures) {
            if (signature == null) return Collections.emptySet();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digests.add(bytesToHex(digest.digest(signature.toByteArray())));
        }
        return digests;
    }

    private void launchVerifiedApkInstaller(Uri apkUri, DownloadManager dm, long id) {
        try {
            Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                    .setData(apkUri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(install);
        } catch (Exception e) {
            Log.w(TAG, "Verified APK installer unavailable: " + e.getClass().getSimpleName());
            dm.remove(id);
            postApkProgress(0, 0, "failed");
            Toast.makeText(this, "باز کردن نصب‌کننده ممکن نشد.", Toast.LENGTH_LONG).show();
        }
    }

    private void rejectApkDownload(DownloadManager dm, long id, String reason) {
        activeApkDownloads.remove(id);
        clearPendingApk(id);
        try {
            dm.remove(id);
        } catch (Exception e) {
            Log.w(TAG, "Rejected APK cleanup failed: " + e.getClass().getSimpleName());
        }
        Log.w(TAG, "APK update rejected: " + reason);
        postApkProgress(0, 0, "failed");
        runOnUiThread(() -> Toast.makeText(
                this, "فایل به‌روزرسانی معتبر نبود و حذف شد.", Toast.LENGTH_LONG).show());
    }

    private void postApkProgress(long done, long total, String status) {
        final String safeStatus = Arrays.asList("downloading", "verifying", "done", "failed")
                .contains(status) ? status : "failed";
        final String js = "window.onApkDownloadProgress&&window.onApkDownloadProgress("
                + Math.max(0, done) + "," + Math.max(0, total) + ",'" + safeStatus + "')";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    private static byte[] hexToBytes(String value) {
        if (value == null || !value.matches("^[0-9a-f]{64}$")) {
            throw new IllegalArgumentException("invalid sha256");
        }
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < value.length(); i += 2) {
            out[i / 2] = (byte) Integer.parseInt(value.substring(i, i + 2), 16);
        }
        return out;
    }

    private static String bytesToHex(byte[] value) {
        StringBuilder out = new StringBuilder(value.length * 2);
        for (byte b : value) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }

    // ---- asset extraction helpers (iterative — avoids stack overflow on deep node_modules) ----

    private interface CopyProgress {
        void onFilesCopied(int count);
    }

    private static boolean projectIsValid(File projectDir) {
        return new File(projectDir, "main.js").isFile()
                && new File(projectDir, "server/server.js").isFile()
                && new File(projectDir, "node_modules/express/package.json").isFile();
    }

    private boolean assetsWereUpdated(Context ctx) {
        try {
            long apkTime = new File(ctx.getPackageManager()
                    .getApplicationInfo(ctx.getPackageName(), 0).sourceDir).lastModified();
            SharedPreferences prefs = ctx.getSharedPreferences("node", MODE_PRIVATE);
            return prefs.getLong("apkTime", 0) != apkTime;
        } catch (Exception e) {
            return true;
        }
    }

    private void saveAssetStamp(Context ctx) {
        try {
            long apkTime = new File(ctx.getPackageManager()
                    .getApplicationInfo(ctx.getPackageName(), 0).sourceDir).lastModified();
            ctx.getSharedPreferences("node", MODE_PRIVATE).edit().putLong("apkTime", apkTime).apply();
        } catch (Exception ignored) { }
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Breadth-first copy; throws on failure so a partial extract is retried next launch. */
    private static void copyAssetFolderSafe(AssetManager am, String src, String dst, CopyProgress progress)
            throws Exception {
        ArrayDeque<String[]> queue = new ArrayDeque<>();
        queue.add(new String[]{src, dst});
        int copied = 0;
        while (!queue.isEmpty()) {
            String[] item = queue.removeFirst();
            String rel = item[0];
            String out = item[1];
            String[] files = am.list(rel);
            if (files == null) continue;
            if (files.length == 0) {
                copyAssetFile(am, rel, out);
                copied++;
                if (progress != null && copied % 200 == 0) progress.onFilesCopied(copied);
            } else {
                //noinspection ResultOfMethodCallIgnored
                new File(out).mkdirs();
                for (String f : files) {
                    queue.addLast(new String[]{rel + "/" + f, out + "/" + f});
                }
            }
        }
        if (progress != null) progress.onFilesCopied(copied);
    }

    private static void copyAssetFile(AssetManager am, String src, String dst) throws Exception {
        File parent = new File(dst).getParentFile();
        if (parent != null) parent.mkdirs();
        try (InputStream in = am.open(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void warnIfRiskyEnvironment() {
        boolean debuggable = BuildConfig.DEBUG
                || (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        boolean rooted = isLikelyRooted();
        if (!debuggable && !rooted) return;
        Log.w(TAG, "Security warning: debuggable=" + debuggable + ", rooted=" + rooted);
        String message = rooted
                ? "هشدار امنیتی: دستگاه احتمالاً روت شده است. اطلاعات حساس در معرض خطر است."
                : "هشدار امنیتی: نسخه Debug برای استفاده عملیاتی مناسب نیست.";
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    private static boolean isLikelyRooted() {
        if (Build.TAGS != null && Build.TAGS.contains("test-keys")) return true;
        String[] paths = {
                "/system/app/Superuser.apk",
                "/system/bin/su",
                "/system/xbin/su",
                "/sbin/su",
                "/su/bin/su",
                "/data/adb/magisk",
                "/data/adb/modules"
        };
        for (String path : paths) {
            if (new File(path).exists()) return true;
        }
        return false;
    }

    private void ensureUpdateNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                UPDATE_CHANNEL_ID,
                "به‌روزرسانی ERP ترنم",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        ch.setDescription("اعلان نسخه جدید برنامه");
        nm.createNotificationChannel(ch);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(
                new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                REQ_POST_NOTIFICATIONS
        );
    }

    private void showUpdateNotification(String title, String body) {
        try {
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                b = new Notification.Builder(this, UPDATE_CHANNEL_ID);
            } else {
                b = new Notification.Builder(this);
            }
            b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle(title != null && !title.isEmpty() ? title : "به‌روزرسانی ERP ترنم")
                    .setContentText(body != null ? body : "نسخه جدید آماده است")
                    .setStyle(new Notification.BigTextStyle().bigText(body != null ? body : ""))
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                b.setPriority(Notification.PRIORITY_DEFAULT);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(updateNotifId++, b.build());
        } catch (Exception e) {
            Log.w(TAG, "showUpdateNotification failed", e);
        }
    }

    /** Bridge called from WebView JS: AndroidBridge.notifyUpdate(title, body) */
    private class AndroidBridge {
        @JavascriptInterface
        public void notifyUpdate(String title, String body) {
            runOnUiThread(() -> showUpdateNotification(title, body));
        }

        @JavascriptInterface
        public String downloadVerifiedApk(String url, String sha256, long size) {
            return beginVerifiedApkDownload(url, sha256, size);
        }
    }
}
