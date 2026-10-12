package app.solsentry.kywservice

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KywServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("KywService")

    Function("start") { text: String, force: Boolean ->
      val intent = Intent(context, KywValidationService::class.java)
        .putExtra(KywValidationService.EXTRA_TEXT, text)
        .putExtra(KywValidationService.EXTRA_FORCE, force)
      ContextCompat.startForegroundService(context, intent)
    }

    Function("stop") {
      context.stopService(Intent(context, KywValidationService::class.java))
    }

    Function("isRunning") { KywValidationService.running }

    Function("setText") { text: String ->
      KywValidationService.lastText = text
      if (KywValidationService.running) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(KywValidationService.NOTIFICATION_ID, KywValidationService.buildNotification(context, text))
      }
    }

    Function("setWidget") { state: String, status: String, figure: String?, unit: String?, today: String? ->
      KywWidget.set(context, state, status, figure, unit, today)
    }

    Function("powerState") {
      val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
      val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
      val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "batteryPct" to if (level >= 0 && scale > 0) level * 100.0 / scale else null,
        "charging" to (plugged != 0),
        // Microampere-hours left, when the fuel gauge reports it; finer than the percentage.
        "chargeUah" to batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER),
        "online" to (capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true),
        "wifi" to (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true),
        "ignoringBatteryOptimizations" to power.isIgnoringBatteryOptimizations(context.packageName),
        "powerSave" to power.isPowerSaveMode,
        "screenOn" to power.isInteractive,
      )
    }

    Function("requestBatteryExemption") {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:" + context.packageName))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
      } catch (e: Exception) {
        context.startActivity(
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      }
    }
  }
}
