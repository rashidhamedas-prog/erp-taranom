package ir.taranom.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;

/**
 * CRM Taranom — offline Android app.
 *
 * Boots an embedded Node.js runtime (nodejs-mobile) running the exact same
 * Express/SQLite backend as the central server, with SYNC_ROLE=device.
 */
public class MainActivity extends Activity {

    private static final String TAG = "CRMTaranom";
    private static final int LOCAL_PORT = 3210;
    private static boolean nodeStarted = false;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    /** JNI bridge implemented in cpp/native-lib.cpp */
    public native Integer startNodeWithArguments(String[] arguments);

    private WebView webView;

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
            ws.setAllowFileAccess(false);
            ws.setSupportMultipleWindows(false);
            ws.setUserAgentString(ws.getUserAgentString() + " CRMTaranomAndroid/" + BuildConfig.VERSION_NAME);
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
            webView.setWebViewClient(new WebViewClient());
            setContentView(webView);
        } catch (Exception e) {
            Log.e(TAG, "WebView init failed", e);
            showErrorPage("خطا در بارگذاری رابط برنامه", e.getMessage());
            return;
        }

        showSplash();
        startBootPipeline();
    }

    private void startBootPipeline() {
        new Thread(() -> {
            try {
                final Context ctx = getApplicationContext();
                File projectDir = new File(ctx.getFilesDir(), "nodejs-project");
                if (assetsWereUpdated(ctx)) {
                    Log.i(TAG, "Extracting bundled Node project...");
                    deleteRecursive(projectDir);
                    copyAssetFolderSafe(ctx.getAssets(), "nodejs-project", projectDir.getAbsolutePath());
                    saveAssetStamp(ctx);
                    Log.i(TAG, "Asset extraction complete");
                }
                File mainJs = new File(projectDir, "main.js");
                if (!mainJs.isFile()) {
                    throw new IllegalStateException("main.js missing after extraction");
                }
                if (!nodeStarted) {
                    nodeStarted = true;
                    File dataDir = new File(ctx.getFilesDir(), "crm-data");
                    //noinspection ResultOfMethodCallIgnored
                    dataDir.mkdirs();
                    Log.i(TAG, "Starting embedded Node server...");
                    startNodeWithArguments(new String[]{
                            "node",
                            mainJs.getAbsolutePath(),
                            dataDir.getAbsolutePath(),
                            String.valueOf(LOCAL_PORT)
                    });
                }
            } catch (Throwable t) {
                Log.e(TAG, "Boot pipeline failed", t);
                showErrorPage("خطا در آماده‌سازی برنامه",
                        t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
            }
        }, "crm-boot").start();

        loadWhenReady();
    }

    private void showSplash() {
        webView.loadDataWithBaseURL(null,
                "<html dir='rtl'><body style='display:flex;align-items:center;justify-content:center;height:96vh;margin:0;font-family:sans-serif;background:#0D1512;color:#E8F1EB'>"
                        + "<div style='text-align:center'><div style='font-size:52px'>🌿</div><h2 style='margin:8px 0'>CRM ترنم</h2>"
                        + "<p style='color:#7F978A;line-height:1.9'>در حال آماده‌سازی برنامه...<br>اولین اجرا ممکن است چند دقیقه طول بکشد — برنامه را نبندید.</p></div></body></html>",
                "text/html", "utf-8", null);
    }

    private void showErrorPage(String title, String detail) {
        String safeTitle = htmlEscape(title != null ? title : "خطا");
        String safeDetail = htmlEscape(detail != null ? detail : "");
        String html = "<html dir='rtl'><body style='font-family:sans-serif;padding:40px;text-align:center;background:#0D1512;color:#E8F1EB'>"
                + "<h3>" + safeTitle + "</h3>"
                + "<p style='color:#7F978A;word-break:break-word'>" + safeDetail + "</p>"
                + "<p style='color:#7F978A'>برنامه را کامل ببندید و دوباره باز کنید. اگر تکرار شد، نسخه را حذف و دوباره نصب کنید.</p></body></html>";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            }
        });
    }

    private static String htmlEscape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void loadWhenReady() {
        new Thread(() -> {
            for (int i = 0; i < 600; i++) {
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                            new java.net.URL("http://127.0.0.1:" + LOCAL_PORT + "/").openConnection();
                    c.setConnectTimeout(1500);
                    c.setReadTimeout(1500);
                    int code = c.getResponseCode();
                    c.disconnect();
                    if (code == 200) {
                        runOnUiThread(() -> webView.loadUrl("http://127.0.0.1:" + LOCAL_PORT + "/"));
                        return;
                    }
                } catch (Exception ignored) { /* server not up yet */ }
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
            showErrorPage("خطا در راه‌اندازی سرور داخلی",
                    "پس از ۱۰ دقیقه پاسخی از سرور داخلی دریافت نشد.");
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

    /** Breadth-first copy; throws IOException-style failures up to the boot thread handler. */
    private static void copyAssetFolderSafe(AssetManager am, String src, String dst) throws Exception {
        ArrayDeque<String[]> queue = new ArrayDeque<>();
        queue.add(new String[]{src, dst});
        while (!queue.isEmpty()) {
            String[] item = queue.removeFirst();
            String rel = item[0];
            String out = item[1];
            String[] files = am.list(rel);
            if (files == null) continue;
            if (files.length == 0) {
                copyAssetFile(am, rel, out);
            } else {
                //noinspection ResultOfMethodCallIgnored
                new File(out).mkdirs();
                for (String f : files) {
                    queue.addLast(new String[]{rel + "/" + f, out + "/" + f});
                }
            }
        }
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
}
