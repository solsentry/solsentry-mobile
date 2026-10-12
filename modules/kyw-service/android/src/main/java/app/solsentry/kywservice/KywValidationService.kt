package app.solsentry.kywservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the JavaScript validation loop alive while the app is in the background or the screen is
 * off. Android requires a foreground service with a visible notification for that. The service
 * stops by itself when the JavaScript task returns.
 */
class KywValidationService : HeadlessJsTaskService() {

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: lastText
    lastText = text
    val notification = buildNotification(this, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // FORCE: JavaScript has no loop running, so any task this service thinks it has is gone.
    if (intent?.getBooleanExtra(EXTRA_FORCE, false) == true) taskStarted = false
    if (taskStarted) return START_NOT_STICKY
    taskStarted = true
    running = true
    super.onStartCommand(intent, flags, startId)
    // Not redelivered: after the process dies the user switches validation on again.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    // The loop returned (validation switched off): end the service now, not "later".
    taskStarted = false
    running = false
    super.onHeadlessJsTaskFinish(taskId)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    taskStarted = false
    KywWidget.markOff(this)
    super.onDestroy()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  companion object {
    const val TASK_NAME = "KywValidation"
    const val EXTRA_TEXT = "text"
    const val EXTRA_FORCE = "force"
    const val CHANNEL_ID = "kyw-validation"
    const val NOTIFICATION_ID = 7301

    @Volatile var running = false
    @Volatile private var taskStarted = false
    @Volatile var lastText = "Verification is on"

    fun buildNotification(context: Context, text: String): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(CHANNEL_ID, "Verification", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shown while verification is running."
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open = launch?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_kyw_stat)
        .setContentTitle(context.applicationInfo.loadLabel(context.packageManager))
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(open)
        .build()
    }
  }
}
