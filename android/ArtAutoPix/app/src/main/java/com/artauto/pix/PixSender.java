package com.artauto.pix;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class PixSender {
    static final String ENDPOINT = "https://whatsapp-baileys-so8k.onrender.com/pix/lucao";
    private static final String PREFS = "artauto_pix";
    private static final String PENDING = "pending";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final Object LOCK = new Object();

    private PixSender() {}

    static void enqueue(Context context, JSONObject payload) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            JSONArray queue = readQueue(app);
            String id = payload.optString("id");
            boolean exists = false;
            for (int i = 0; i < queue.length(); i++) {
                if (id.equals(queue.optJSONObject(i).optString("id"))) {
                    exists = true;
                    break;
                }
            }
            if (!exists) queue.put(payload);
            saveQueue(app, queue);
        }
        flushAsync(app);
    }

    static void flushAsync(Context context) {
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> flush(app));
    }

    static int pendingCount(Context context) {
        synchronized (LOCK) {
            return readQueue(context.getApplicationContext()).length();
        }
    }

    private static void flush(Context context) {
        synchronized (LOCK) {
            JSONArray queue = readQueue(context);
            JSONArray remaining = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject payload = queue.optJSONObject(i);
                if (payload == null || !post(payload)) remaining.put(payload);
            }
            saveQueue(context, remaining);
        }
    }

    private static boolean post(JSONObject payload) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                try (BufferedReader ignored = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                    // Consumir a resposta permite reutilização correta da conexão.
                }
                return true;
            }
        } catch (Exception ignored) {
            // O registro permanece na fila para uma nova tentativa.
        } finally {
            if (connection != null) connection.disconnect();
        }
        return false;
    }

    private static JSONArray readQueue(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONArray(prefs.getString(PENDING, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private static void saveQueue(Context context, JSONArray queue) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(PENDING, queue.toString()).apply();
    }
}
