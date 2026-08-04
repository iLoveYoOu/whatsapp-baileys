package com.artauto.pix;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildContent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
        PixSender.flushAsync(this);
    }

    private View buildContent() {
        int padding = dp(20);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(padding, padding, padding, padding);

        TextView title = text("ArtAuto Pix", 28, Color.rgb(8, 120, 62));
        content.addView(title);
        TextView subtitle = text("Beta Lucão • Banco Inter", 16, Color.DKGRAY);
        subtitle.setPadding(0, dp(4), 0, dp(20));
        content.addView(subtitle);

        status = text("", 17, Color.BLACK);
        status.setBackgroundColor(Color.rgb(242, 244, 247));
        status.setPadding(dp(14), dp(14), dp(14), dp(14));
        content.addView(status, new LinearLayout.LayoutParams(-1, -2));

        content.addView(button("Autorizar acesso às notificações", v -> {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        }));

        content.addView(button("Enviar teste", v -> sendTest()));
        content.addView(button("Reenviar pendentes", v -> {
            PixSender.flushAsync(this);
            updateStatus();
        }));
        content.addView(button("Abrir registros", v -> {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PixSender.ENDPOINT)));
        }));

        TextView note = text(
            "O aplicativo captura somente notificações do Banco Inter relacionadas a Pix recebidos. " +
            "Não acessa senha, saldo, iSafe ou o conteúdo interno do banco.",
            14, Color.GRAY
        );
        note.setPadding(0, dp(20), 0, 0);
        content.addView(note);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        return scroll;
    }

    private void sendTest() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("id", "teste-apk-" + System.currentTimeMillis());
            payload.put("titulo", "TESTE ARTAUTO PIX");
            payload.put("texto", "ArtAutoPix instalado e conectado. Nenhum Pix real.");
            payload.put("aplicativo", "ArtAuto Pix");
            payload.put("capturadoEm", System.currentTimeMillis());
            PixSender.enqueue(this, payload);
            status.postDelayed(this::updateStatus, 1200);
        } catch (Exception ignored) {}
    }

    private void updateStatus() {
        boolean enabled = notificationAccessEnabled();
        int pending = PixSender.pendingCount(this);
        status.setText(getString(
            R.string.status_format,
            getString(enabled ? R.string.status_authorized : R.string.status_pending),
            pending,
            PixSender.ENDPOINT
        ));
        status.setTextColor(enabled ? Color.rgb(8, 120, 62) : Color.rgb(180, 60, 30));
    }

    private boolean notificationAccessEnabled() {
        String enabled = Settings.Secure.getString(
            getContentResolver(), "enabled_notification_listeners"
        );
        if (enabled == null) return false;
        ComponentName component = new ComponentName(this, InterNotificationService.class);
        return enabled.contains(component.flattenToString()) || enabled.contains(getPackageName());
    }

    private Button button(String label, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(52));
        params.topMargin = dp(12);
        button.setLayoutParams(params);
        return button;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
