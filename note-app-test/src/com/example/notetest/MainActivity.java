package com.example.notetest;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREFS = "notes";
    private static final String KEY_TITLE = "title";
    private static final String KEY_BODY = "body";
    private EditText title;
    private EditText body;
    private SharedPreferences store;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        store = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildScreen();
        loadNote();
    }

    private void buildScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(18), dp(20), dp(14));
        root.setBackgroundColor(Color.rgb(247, 248, 252));

        TextView heading = new TextView(this);
        heading.setText("轻记");
        heading.setTextSize(30);
        heading.setTextColor(Color.rgb(25, 35, 65));
        heading.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(heading, new LinearLayout.LayoutParams(-1, dp(54)));

        TextView hint = new TextView(this);
        hint.setText("把重要的事，写在这里");
        hint.setTextSize(14);
        hint.setTextColor(Color.rgb(100, 110, 130));
        root.addView(hint, new LinearLayout.LayoutParams(-1, dp(30)));

        title = new EditText(this);
        title.setHint("笔记标题");
        title.setTextSize(19);
        title.setSingleLine(true);
        title.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        root.addView(title, new LinearLayout.LayoutParams(-1, dp(58)));

        body = new EditText(this);
        body.setHint("开始记录...");
        body.setTextSize(16);
        body.setGravity(Gravity.TOP);
        body.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        body.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, 0, 1);
        bodyParams.topMargin = dp(8);
        root.addView(body, bodyParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(10), 0, 0);

        Button clear = new Button(this);
        clear.setText("清空");
        clear.setOnClickListener(v -> {
            title.setText("");
            body.setText("");
            store.edit().clear().apply();
            Toast.makeText(this, "已清空", Toast.LENGTH_SHORT).show();
        });
        actions.addView(clear, new LinearLayout.LayoutParams(dp(100), dp(52)));

        Button save = new Button(this);
        save.setText("保存笔记");
        save.setTextColor(Color.WHITE);
        save.setBackgroundColor(Color.rgb(63, 81, 181));
        save.setOnClickListener(v -> saveNote());
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(dp(130), dp(52));
        saveParams.leftMargin = dp(8);
        actions.addView(save, saveParams);
        root.addView(actions, new LinearLayout.LayoutParams(-1, dp(66)));

        setContentView(root);
    }

    private void loadNote() {
        title.setText(store.getString(KEY_TITLE, ""));
        body.setText(store.getString(KEY_BODY, ""));
    }

    private void saveNote() {
        store.edit().putString(KEY_TITLE, title.getText().toString())
                .putString(KEY_BODY, body.getText().toString()).apply();
        Toast.makeText(this, "笔记已保存", Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
