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
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

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
            ws.setAllowContentAccess(true);
            ws.setSupportMultipleWindows(false);
            ws.setLoadsImagesAutomatically(true);
            ws.setBlockNetworkImage(false);
            ws.setCacheMode(WebSettings.LOAD_DEFAULT);
            ws.setUseWideViewPort(true);
            ws.setLoadWithOverviewMode(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ws.setSafeBrowsingEnabled(false);
            }
            ws.setUserAgentString(ws.getUserAgentString() + " ERPTaranomAndroid/" + BuildConfig.VERSION_NAME);

            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage msg) {
                    Log.d(TAG, "JS: " + msg.message() + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")");
                    return true;
                }
            });

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request == null || !request.isForMainFrame()) return;
                    CharSequence desc = error != null ? error.getDescription() : "unknown";
                    Log.e(TAG, "WebView main frame error: " + desc);
                    showErrorPage("خطا در بارگذاری رابط برنامه",
                            desc.toString() + "\n\n" + readBootLogTail());
                }
            });

            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
                try {
                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) {
                        long id = dm.enqueue(req);
                        boolean isApk = fileName.endsWith(".apk")
                                || "application/vnd.android.package-archive".equals(mimeType);
                        if (isApk) trackApkDownload(dm, id);
                    }
                } catch (Exception e) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
            });
            ensureUpdateNotificationChannel();
            requestNotificationPermissionIfNeeded();
            webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
            setContentView(webView);
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
            try {
                Integer code = startNodeWithArguments(new String[]{
                        "node",
                        mainJs.getAbsolutePath(),
                        dataDir.getAbsolutePath(),
                        String.valueOf(LOCAL_PORT),
                        nativeLibDir != null ? nativeLibDir : ""
                });
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

    private void trackApkDownload(final DownloadManager dm, final long id) {
        final Handler h = new Handler(Looper.getMainLooper());
        h.post(new Runnable() {
            @Override
            public void run() {
                long done = 0, total = 0;
                int status = DownloadManager.STATUS_RUNNING;
                DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
                try (android.database.Cursor c = dm.query(q)) {
                    if (c != null && c.moveToFirst()) {
                        done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception ignored) { }
                String jsStatus = status == DownloadManager.STATUS_SUCCESSFUL ? "done"
                        : status == DownloadManager.STATUS_FAILED ? "failed" : "downloading";
                final String js = "window.onApkDownloadProgress&&window.onApkDownloadProgress("
                        + done + "," + total + ",'" + jsStatus + "')";
                if (webView != null) webView.evaluateJavascript(js, null);
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    try {
                        Uri apk = dm.getUriForDownloadedFile(id);
                        Intent install = new Intent(Intent.ACTION_VIEW)
                                .setDataAndType(apk, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(install);
                    } catch (Exception ignored) { }
                } else if (status != DownloadManager.STATUS_FAILED) {
                    h.postDelayed(this, 600);
                }
            }
        });
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
    }
}
