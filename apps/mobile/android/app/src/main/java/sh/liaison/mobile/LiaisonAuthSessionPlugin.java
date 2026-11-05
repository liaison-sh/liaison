// SPDX-License-Identifier: FSL-1.1-ALv2
package sh.liaison.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android's counterpart of the iOS plugin's `authenticate`
 * (ios/App/App/LiaisonNativePlugin.swift; JS: src/native/liaison-native.ts):
 * a web sign in, or an app connection, run in the system browser and ended
 * by the server's handoff page on `liaison://oauth-complete?...`.
 *
 * Android has no ASWebAuthenticationSession, so the page opens in the
 * browser and its callback comes back as the VIEW intent the main activity's
 * `liaison` filter receives (singleTask: delivered to this activity through
 * onNewIntent). The first such intent while a call is waiting resolves it
 * with the URL. Another app on the device can also claim the scheme and read
 * that link, which is why the link carries nothing usable on its own: its
 * code is redeemed only with the PKCE verifier the page kept, by the page's
 * own session (apps/web settings/oauth-connect.ts, auth/Login.tsx).
 *
 * Coming back to the app with no callback (the user closed the browser or
 * switched back) rejects the call with code `cancelled`, like a dismissed
 * sheet on iOS.
 */
@CapacitorPlugin(name = "LiaisonAuthSession")
public class LiaisonAuthSessionPlugin extends Plugin {

    /** How long a resume waits for the callback intent that may follow it. */
    private static final long CANCEL_GRACE_MS = 800;

    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall waiting;
    private String waitingScheme;
    /** The browser took the screen: a later resume without a callback is a cancel. */
    private boolean leftForBrowser;

    @PluginMethod
    public void authenticate(PluginCall call) {
        String raw = call.getString("url");
        String callbackScheme = call.getString("callbackScheme");
        Uri url = raw == null ? null : Uri.parse(raw);
        String scheme = url == null ? null : url.getScheme();
        if (url == null || scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) {
            call.reject("authenticate needs an http(s) url", "invalid");
            return;
        }
        if (callbackScheme == null || callbackScheme.isEmpty()) {
            call.reject("authenticate needs a callbackScheme", "invalid");
            return;
        }
        // One session at a time, as on iOS: a newer one supersedes the wait.
        if (waiting != null) {
            waiting.reject("A newer sign in was started.", "cancelled");
            waiting = null;
        }
        Intent browser = new Intent(Intent.ACTION_VIEW, url);
        browser.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            getActivity().startActivity(browser);
        } catch (ActivityNotFoundException error) {
            call.reject("No browser can open the sign in page", "unavailable");
            return;
        }
        // Held unresolved (no keepAlive: it settles exactly once) until the
        // callback intent or the cancel below.
        waiting = call;
        waitingScheme = callbackScheme.toLowerCase();
        leftForBrowser = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (waiting == null || intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || data.getScheme() == null) return;
        if (!data.getScheme().equalsIgnoreCase(waitingScheme)) return;
        PluginCall call = waiting;
        waiting = null;
        JSObject result = new JSObject();
        result.put("url", data.toString());
        call.resolve(result);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (waiting != null) leftForBrowser = true;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (waiting == null || !leftForBrowser) return;
        final PluginCall call = waiting;
        // The callback intent arrives just before this resume; a resume with
        // none after the grace is the user coming back without signing in.
        main.postDelayed(
            () -> {
                if (waiting != call) return;
                waiting = null;
                call.reject("The sign in was cancelled.", "cancelled");
            },
            CANCEL_GRACE_MS
        );
    }
}
