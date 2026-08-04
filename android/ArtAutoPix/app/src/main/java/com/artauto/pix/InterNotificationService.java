package com.artauto.pix;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.text.Normalizer;
import java.util.Locale;

public class InterNotificationService extends NotificationListenerService {
    private static final String INTER_PACKAGE = "br.com.intermedium";

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        PixSender.flushAsync(this);
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null || !INTER_PACKAGE.equals(sbn.getPackageName())) return;

        Notification notification = sbn.getNotification();
        Bundle extras = notification == null ? null : notification.extras;
        if (extras == null) return;

        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String message = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (message.isEmpty()) message = text(extras.getCharSequence(Notification.EXTRA_TEXT));
        String combined = normalize(title + " " + message);

        if (!combined.contains("pix")) return;
        if (!(combined.contains("receb") || combined.contains("te enviou")
            || combined.contains("creditad") || combined.contains("entrada"))) return;

        try {
            JSONObject payload = new JSONObject();
            payload.put("id", sbn.getKey() + "-" + sbn.getPostTime());
            payload.put("titulo", title);
            payload.put("texto", message);
            payload.put("aplicativo", "Banco Inter");
            payload.put("pacote", sbn.getPackageName());
            payload.put("capturadoEm", System.currentTimeMillis());
            PixSender.enqueue(this, payload);
        } catch (Exception ignored) {
            // Uma notificação inválida não deve derrubar o listener.
        }
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }

    private static String normalize(String value) {
        return Normalizer.normalize(value, Normalizer.Form.NFD)
            .replaceAll("\\p{M}+", "")
            .toLowerCase(Locale.ROOT);
    }
}
