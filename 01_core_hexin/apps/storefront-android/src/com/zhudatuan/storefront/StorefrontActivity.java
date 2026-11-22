package com.zhudatuan.storefront;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public final class StorefrontActivity extends Activity {
    private static final String STOREFRONT = "https://www.zhudatuan.com/";
    private static final int FILE_CHOOSER_REQUEST = 1;

    private WebView storefront;
    private View errorView;
    private String failedUrl;
    private ValueCallback<Uri[]> fileSelection;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout content = new FrameLayout(this);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            content.setOnApplyWindowInsetsListener((view, windowInsets) -> {
                Insets insets = windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime()
                );
                view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        storefront = new WebView(this);
        WebSettings settings = storefront.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        storefront.setWebViewClient(new StorefrontNavigation());
        storefront.setWebChromeClient(new StorefrontChrome());

        content.addView(storefront);
        errorView = createErrorView();
        content.addView(errorView);
        setContentView(content);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack
            );
        }
        if (state == null || storefront.restoreState(state) == null) {
            storefront.loadUrl(STOREFRONT);
        }
    }

    private View createErrorView() {
        LinearLayout message = new LinearLayout(this);
        message.setOrientation(LinearLayout.VERTICAL);
        message.setGravity(Gravity.CENTER);
        message.setBackgroundColor(0xfffafafa);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        message.setPadding(padding, padding, padding, padding);

        TextView text = new TextView(this);
        text.setText(R.string.page_unavailable);
        message.addView(text);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> storefront.loadUrl(failedUrl == null ? STOREFRONT : failedUrl));
        message.addView(retry);
        message.setVisibility(View.GONE);
        return message;
    }

    private final class StorefrontNavigation extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            Uri uri = request.getUrl();
            if (isStorefrontUrl(uri)) return false;

            String scheme = uri.getScheme();
            if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)
                || "tel".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
                    return true;
                } catch (ActivityNotFoundException ignored) {
                    // The device has no installed handler for this link.
                }
            }
            Toast.makeText(StorefrontActivity.this, R.string.link_unavailable, Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            errorView.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            failedUrl = isStorefrontUrl(request.getUrl()) ? request.getUrl().toString() : null;
            errorView.setVisibility(View.VISIBLE);
        }
    }

    private static boolean isStorefrontUrl(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        return "www.zhudatuan.com".equalsIgnoreCase(host)
            || "zhudatuan.com".equalsIgnoreCase(host)
            || "h5.zhudatuan.com".equalsIgnoreCase(host)
            || "accounts.zhudatuan.com".equalsIgnoreCase(host);
    }

    private final class StorefrontChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileSelection != null) fileSelection.onReceiveValue(null);
            fileSelection = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
            } catch (ActivityNotFoundException ignored) {
                fileSelection.onReceiveValue(null);
                fileSelection = null;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != FILE_CHOOSER_REQUEST || fileSelection == null) return;
        ValueCallback<Uri[]> callback = fileSelection;
        fileSelection = null;
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        storefront.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onPause() {
        storefront.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        storefront.onResume();
    }

    @Override
    public void onBackPressed() {
        navigateBack();
    }

    private void navigateBack() {
        if (storefront.canGoBack()) {
            storefront.goBack();
        } else {
            finish();
        }
    }

    @Override
    protected void onDestroy() {
        if (fileSelection != null) fileSelection.onReceiveValue(null);
        ((FrameLayout) storefront.getParent()).removeView(storefront);
        storefront.destroy();
        super.onDestroy();
    }
}
