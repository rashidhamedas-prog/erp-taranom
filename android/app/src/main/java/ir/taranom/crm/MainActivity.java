package ir.taranom.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * CRM Taranom — offline Android app.
 *
 * Boots an embedded Node.js runtime (nodejs-mobile) running the exact same
 * Express/SQLite backend as the central server, with SYNC_ROLE=device: all
 * data is stored on the device and every operation works with no
 * connectivity; the built-in sync client pushes/pulls changes to the central
 * server whenever the network allows. The WebView simply renders the local
 * server's UI — identical to the web and Windows versions.
 */
public class MainActivity extends Activity {

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    /** JNI bridge implemented in cpp/native-lib.cpp */
    public native Integer startNodeWithArguments(String[] arguments);

    private static final int LOCAL_PORT = 3210;
    private static boolean nodeStarted = false;
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setSupportMultipleWindows(false); // invoice print opens in-place
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        if (!nodeStarted) {
            nodeStarted = true;
            final Context ctx = getApplicationContext();
            new Thread(() -> {
                File projectDir = new File(ctx.getFilesDir(), "nodejs-project");
                // Re-extract the bundled Node project when the APK changes
                if (assetsWereUpdated(ctx)) {
                    deleteRecursive(projectDir);
                    copyAssetFolder(ctx.getAssets(), "nodejs-project", projectDir.getAbsolutePath());
                    saveAssetStamp(ctx);
                }
                File dataDir = new File(ctx.getFilesDir(), "crm-data");
                //noinspection ResultOfMethodCallIgnored
                dataDir.mkdirs();
                startNodeWithArguments(new String[]{
                        "node",
                        new File(projectDir, "main.js").getAbsolutePath(),
                        dataDir.getAbsolutePath(),
                        String.valueOf(LOCAL_PORT)
                });
            }).start();
        }

        // Poll the embedded server until it answers, then load the app
        loadWhenReady(0);
    }

    private void loadWhenReady(final int attempt) {
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            webView.loadUrl("http://127.0.0.1:" + LOCAL_PORT + "/");
        }, attempt == 0 ? 2500 : 1500);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (attempt < 20 && failingUrl != null && failingUrl.contains("127.0.0.1")) {
                    loadWhenReady(attempt + 1);
                }
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    // ---- asset extraction helpers ----

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

    private static void copyAssetFolder(AssetManager am, String src, String dst) {
        try {
            String[] files = am.list(src);
            if (files == null) return;
            if (files.length == 0) {
                copyAssetFile(am, src, dst);
            } else {
                //noinspection ResultOfMethodCallIgnored
                new File(dst).mkdirs();
                for (String f : files) copyAssetFolder(am, src + "/" + f, dst + "/" + f);
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static void copyAssetFile(AssetManager am, String src, String dst) throws Exception {
        try (InputStream in = am.open(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
}
