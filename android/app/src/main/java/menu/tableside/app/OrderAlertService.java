package menu.tableside.app;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Receives every FCM message for the app (it replaces the push plugin's
 * own service in AndroidManifest.xml). Tableside's kitchen alerts are
 * handled here so they can ring until accepted (OrderAlerts); anything
 * else, and token refreshes, go to the plugin as before.
 */
public class OrderAlertService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        if (OrderAlerts.handle(this, remoteMessage.getData())) return;
        super.onMessageReceived(remoteMessage);
    }
}
