package menu.tableside.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The staff dashboard at tableside.menu (capacitor.config.ts), plus the
 * kitchen alerts' channels and taps (OrderAlerts).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        OrderAlerts.createChannels(this);
        openFromAlert(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromAlert(intent);
    }

    /**
     * A tapped alert opens the dashboard page it's about. Only dashboard
     * paths, the same rule as the server (isSafeNotificationUrl) and the
     * web service worker, so an alert can never open somewhere else.
     */
    private void openFromAlert(Intent intent) {
        if (intent == null || bridge == null) return;
        String path = intent.getStringExtra(OrderAlerts.EXTRA_URL);
        // Touching an order alert silences its ring.
        if (path != null) OrderRingService.silence(this);
        intent.removeExtra(OrderAlerts.EXTRA_URL);
        if (path == null || !path.matches("^/dashboard(/[A-Za-z0-9/_-]*)?$")) return;
        String server = bridge.getServerUrl();
        if (server == null) return;
        Uri base = Uri.parse(server);
        String target = base.getScheme() + "://" + base.getEncodedAuthority() + path;
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(target));
    }
}
