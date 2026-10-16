package menu.tableside.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;

/**
 * Plays the order ring itself, looped on the alarm stream.
 *
 * A notification channel's custom sound is not enough: some phone makers'
 * software (vivo/iQOO, seen 2026-10-13) swaps an app's channel sound for
 * the system default. So the "New orders" alert is silent and this
 * service plays res/raw/order_ring.wav, which no OS skin can replace.
 *
 * It runs as a short foreground service (Android 14+'s shortService
 * type, which needs no extra permission or Play declaration) and rings in
 * bursts just under the server's 30-second repeat (ringPendingOrders):
 * every repeat starts it again, so it sounds near-continuously until the
 * alert is touched or dismissed, or a "stop" arrives because the order
 * was accepted. After a burst the alert stays on screen.
 */
public class OrderRingService extends Service {

    static final String ACTION_RING = "menu.tableside.app.RING";
    static final String ACTION_STOP = "menu.tableside.app.STOP_RING";
    static final String EXTRA_NOTIFICATION = "menu.tableside.app.NOTIFICATION";
    static final String EXTRA_ID = "menu.tableside.app.ID";

    /** Just under the server's 30-second repeat. */
    private static final long BURST_MS = 28_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable endBurst = () -> stop(false);
    private MediaPlayer player;
    private int notificationId;

    static void ring(Context context, int id, Notification notification) {
        Intent intent = new Intent(context, OrderRingService.class)
            .setAction(ACTION_RING)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_NOTIFICATION, notification);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException notAllowed) {
            // Starting from the background can be refused (no high-priority
            // FCM exemption left): the alert is still shown and vibrates.
            androidx.core.app.NotificationManagerCompat.from(context).notify(id, notification);
        }
    }

    static void silence(Context context) {
        try {
            context.startService(new Intent(context, OrderRingService.class).setAction(ACTION_STOP));
        } catch (RuntimeException ignored) {
            // Not running, or not allowed to start: nothing is ringing.
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stop(false);
            return START_NOT_STICKY;
        }
        Notification notification = intent.getParcelableExtra(EXTRA_NOTIFICATION);
        notificationId = intent.getIntExtra(EXTRA_ID, 1);
        if (notification == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        ServiceCompat.startForeground(
            this,
            notificationId,
            notification,
            Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE : 0
        );
        startRinging();
        handler.removeCallbacks(endBurst);
        handler.postDelayed(endBurst, BURST_MS);
        return START_NOT_STICKY;
    }

    private void startRinging() {
        if (player != null && player.isPlaying()) return;
        releasePlayer();
        player = MediaPlayer.create(
            this,
            R.raw.order_ring,
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
            0
        );
        if (player == null) return;
        player.setLooping(true);
        player.start();
    }

    /**
     * Ends the ring. The alert stays on screen (detached from the service)
     * unless it was silenced by a stop; OrderAlerts cancels it then.
     */
    private void stop(boolean removeAlert) {
        handler.removeCallbacks(endBurst);
        releasePlayer();
        ServiceCompat.stopForeground(
            this,
            removeAlert ? ServiceCompat.STOP_FOREGROUND_REMOVE : ServiceCompat.STOP_FOREGROUND_DETACH
        );
        stopSelf();
    }

    private void releasePlayer() {
        if (player == null) return;
        try {
            player.stop();
        } catch (IllegalStateException ignored) {
            // Never started.
        }
        player.release();
        player = null;
    }

    /** Android 14+ ends a short service after about three minutes. */
    @Override
    public void onTimeout(int startId) {
        stop(false);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(endBurst);
        releasePlayer();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
