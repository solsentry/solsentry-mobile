package app.solsentry.kywservice

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.view.View
import android.widget.RemoteViews

/**
 * Home screen widget, read only: verification status, the balance and today's count against the cap.
 * JavaScript sends finished strings (setWidget); they are kept in SharedPreferences
 * so the widget can draw itself while the app is not running. A tap opens the app.
 */
class KywWidget : AppWidgetProvider() {

  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    // Drawn by the system, maybe in a fresh process: no service means verification is not running.
    if (!KywValidationService.running) {
      val prefs = prefs(context)
      if (prefs.getString(KEY_STATE, STATE_OFF) != STATE_OFF) {
        prefs.edit().putString(KEY_STATE, STATE_OFF).putString(KEY_STATUS, OFF_TEXT).apply()
      }
    }
    for (id in ids) manager.updateAppWidget(id, views(context))
  }

  companion object {
    private const val PREFS = "kyw_widget"
    private const val KEY_STATE = "state"
    private const val KEY_STATUS = "status"
    private const val KEY_FIGURE = "figure"
    private const val KEY_UNIT = "unit"
    private const val KEY_TODAY = "today"
    const val STATE_ON = "on"
    const val STATE_PAUSED = "paused"
    const val STATE_OFF = "off"
    private const val OFF_TEXT = "Verification is off"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Null keeps the value already stored (JavaScript does not know it yet); "" hides that line. */
    fun set(context: Context, state: String?, status: String?, figure: String?, unit: String?, today: String?) {
      val prefs = prefs(context)
      val edit = prefs.edit()
      var changed = false
      fun put(key: String, value: String?) {
        if (value == null || prefs.getString(key, null) == value) return
        edit.putString(key, value)
        changed = true
      }
      put(KEY_STATE, state)
      put(KEY_STATUS, status)
      put(KEY_FIGURE, figure)
      put(KEY_UNIT, unit)
      put(KEY_TODAY, today)
      if (!changed) return
      edit.apply()
      refresh(context)
    }

    /** The service ended (switched off, or stopped by the system): the widget must not say "on". */
    fun markOff(context: Context) {
      set(context, STATE_OFF, OFF_TEXT, null, null, null)
    }

    private fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, KywWidget::class.java))
      if (ids.isEmpty()) return
      val views = views(context)
      for (id in ids) manager.updateAppWidget(id, views)
    }

    private fun views(context: Context): RemoteViews {
      val prefs = prefs(context)
      val state = prefs.getString(KEY_STATE, STATE_OFF)
      val views = RemoteViews(context.packageName, R.layout.kyw_widget)
      views.setTextViewText(R.id.kyw_widget_status, prefs.getString(KEY_STATUS, OFF_TEXT))
      views.setImageViewResource(
        R.id.kyw_widget_dot,
        when (state) {
          STATE_ON -> R.drawable.kyw_widget_dot_on
          STATE_PAUSED -> R.drawable.kyw_widget_dot_paused
          else -> R.drawable.kyw_widget_dot_off
        },
      )
      views.setTextViewText(R.id.kyw_widget_figure, prefs.getString(KEY_FIGURE, "–"))
      views.setTextViewText(R.id.kyw_widget_unit, prefs.getString(KEY_UNIT, ""))
      val today = prefs.getString(KEY_TODAY, "") ?: ""
      views.setTextViewText(R.id.kyw_widget_today, today)
      views.setViewVisibility(R.id.kyw_widget_today, if (today.isEmpty()) View.GONE else View.VISIBLE)
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        val open = PendingIntent.getActivity(context, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        views.setOnClickPendingIntent(R.id.kyw_widget_root, open)
      }
      return views
    }
  }
}
