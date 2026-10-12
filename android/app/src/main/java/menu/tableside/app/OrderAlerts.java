package menu.tableside.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Map;

/**
 * Kitchen alerts, shown by the app itself so a new order can ring like a
 * delivery tablet.
 *
 * The server sends data-only FCM messages (src/lib/push/fcm-core.ts):
 *   kind=alert  show (or replace) the alert for a group. An order
 *               (urgent=1) goes on the "New orders" channel, whose sound
 *               is a looping chime on the alarm stream, and carries
 *               Android's FLAG_INSISTENT: the sound repeats until the
 *               alert is opened, dismissed or cancelled.
 *   kind=stop   cancel the group's alert, so every phone goes quiet the
 *               moment the order is accepted.
 *
 * One notification per group (the order), so the server's repeats every
 * 30 seconds replace it, and re-ring it if someone swiped it away.
 */
final class OrderAlerts {

    static final String ORDERS_CHANNEL = "orders_v1";
    static final String ALERTS_CHANNEL = "alerts_v1";
    static final String EXTRA_URL = "menu.tableside.app.URL";

    private OrderAlerts() {}

    /** Safe to call often: Android ignores a channel that already exists. */
    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel orders = new NotificationChannel(
            ORDERS_CHANNEL,
            "New orders",
            NotificationManager.IMPORTANCE_HIGH
        );
        orders.setDescription("Rings until someone accepts the order.");
        orders.setSound(
            ringUri(context),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        orders.enableVibration(true);
        orders.setVibrationPattern(new long[] { 0, 600, 300, 600, 300, 600 });
        orders.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(orders);

        NotificationChannel alerts = new NotificationChannel(
            ALERTS_CHANNEL,
            "Table requests and other alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        alerts.setDescription("A table wants a waiter or the bill.");
        manager.createNotificationChannel(alerts);
    }

    static Uri ringUri(Context context) {
        return Uri.parse(
            ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/" + R.raw.order_ring
        );
    }

    static int idFor(String group) {
        return group == null ? 0 : group.hashCode();
    }

    /** True when the message was Tableside's and has been handled. */
    static boolean handle(Context context, Map<String, String> data) {
        String kind = data.get("kind");
        if ("stop".equals(kind)) {
            NotificationManagerCompat.from(context).cancel(idFor(data.get("group")));
            return true;
        }
        if (!"alert".equals(kind)) return false;
        show(context, data);
        return true;
    }

    private static void show(Context context, Map<String, String> data) {
        createChannels(context);
        boolean urgent = "1".equals(data.get("urgent"));
        String group = data.get("group");
        String url = data.get("url");

        Intent open = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_URL, url == null ? "/dashboard/kitchen" : url);
        PendingIntent tap = PendingIntent.getActivity(
            context,
            idFor(group),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            context,
            urgent ? ORDERS_CHANNEL : ALERTS_CHANNEL
        )
            .setSmallIcon(R.drawable.ic_stat_tableside)
            .setColor(0xFF842B02)
            .setContentTitle(data.get("title"))
            .setContentText(data.get("body"))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(urgent ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // Stop on its own after the server's 10-minute ring window.
            .setTimeoutAfter(10 * 60 * 1000L);

        if (urgent && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Before channels, the sound is set per notification.
            builder.setSound(ringUri(context), android.media.AudioManager.STREAM_ALARM);
        }

        Notification notification = builder.build();
        if (urgent) {
            // Ring until opened, dismissed or cancelled by a "stop".
            notification.flags |= Notification.FLAG_INSISTENT;
        }

        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        try {
            manager.notify(idFor(group), notification);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS was revoked; nothing to show.
        }
    }
}
