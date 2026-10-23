package app.solsentry.deviceattestation

import android.os.Build
import android.provider.Settings
import android.security.KeyStoreException
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * Hardware key attestation for the optional "Device check".
 *
 * Generates an EC P-256 key in the Android Keystore with the caller's challenge and reads the
 * attestation certificate chain. The key is deleted afterwards, unless the caller passes keepAlias
 * (the KYW install key, which then signs results through sign()). Nothing else is touched:
 * no serial, no IMEI/MEID (setDevicePropertiesAttestationIncluded only covers brand,
 * device, product, manufacturer and model), no permissions. deviceHint() reads ANDROID_ID, which
 * Android scopes to our signing key and keeps across reinstalls, and returns only its SHA-256.
 */
class DeviceAttestationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceAttestation")

    // Runs off the JS and UI threads (Expo AsyncFunction queue); key generation can take seconds.
    AsyncFunction("attestKey") { challengeB64: String, opts: Map<String, Any?> ->
      attest(challengeB64, opts["strongBox"] == true, opts["includeDeviceIds"] == true, opts["keepAlias"] as? String)
    }

    // Persistent install key (KYW): created once by attestKey with keepAlias, then used to sign results.
    Function("hasKey") { alias: String -> keyStore().containsAlias(alias) }

    // SubjectPublicKeyInfo (DER), base64; null when the key does not exist.
    Function("publicKey") { alias: String ->
      keyStore().getCertificate(alias)?.publicKey?.encoded?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    }

    // SHA-256 (lowercase hex) of ANDROID_ID, or null. The raw id never leaves this function.
    // Lets SolSentry tell a reinstall on the same phone from a new phone; self-reported, measure-only.
    Function("deviceHint") {
      val ctx = appContext.reactContext ?: return@Function null
      val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
      // 9774d56d682e549c: the shared value of an old emulator/firmware bug, not a device.
      if (id.isNullOrBlank() || id == "9774d56d682e549c") return@Function null
      MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    // SHA256withECDSA over the given bytes, DER signature in base64.
    AsyncFunction("sign") { alias: String, dataB64: String ->
      val entry = keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        ?: throw IllegalStateException("no key")
      val sig = Signature.getInstance("SHA256withECDSA")
      sig.initSign(entry.privateKey)
      sig.update(Base64.decode(dataB64, Base64.NO_WRAP))
      Base64.encodeToString(sig.sign(), Base64.NO_WRAP)
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private class Attempt(val strongBox: Boolean, val ids: Boolean)

  private fun attest(challengeB64: String, wantStrongBox: Boolean, wantIds: Boolean, keepAlias: String? = null): Map<String, Any?> {
    val claimed = mapOf(
      "manufacturer" to Build.MANUFACTURER,
      "brand" to Build.BRAND,
      "model" to Build.MODEL,
      "sdkInt" to Build.VERSION.SDK_INT,
    )
    val idsSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val noIdState = when {
      !wantIds -> "not_requested"
      !idsSupported -> "unsupported"
      else -> "error"
    }
    val challenge = try {
      Base64.decode(challengeB64, Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
      return failure("bad challenge: ${e.message}", noIdState, null, claimed)
    }
    if (challenge.isEmpty() || challenge.size > 128) {
      return failure("challenge must be 1..128 bytes", noIdState, null, claimed)
    }

    val tryIds = wantIds && idsSupported
    val tryStrongBox = wantStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    // Refusal is tracked per level: a StrongBox that refuses IDs says nothing about the TEE.
    val idsRefusedAt = mutableSetOf<Boolean>()
    // Unrecognized failure on an attempt WITH IDs: kept verbatim so a field run shows what happened.
    var idError: String? = null

    // StrongBox first (if asked), then TEE; at each level with IDs first (if asked), then without.
    val plan = mutableListOf<Attempt>()
    for (sb in if (tryStrongBox) listOf(true, false) else listOf(false)) {
      if (tryIds) plan.add(Attempt(sb, true))
      plan.add(Attempt(sb, false))
    }

    val errors = mutableListOf<String>()
    var strongBoxGone = false
    for (a in plan) {
      if (a.strongBox && strongBoxGone) continue
      if (a.ids && a.strongBox in idsRefusedAt) continue
      // keepAlias: the key survives a successful attempt (KYW install key); otherwise it is throwaway.
      val alias = keepAlias ?: ("solsentry_attest_" + UUID.randomUUID().toString())
      if (keepAlias != null) deleteQuietly(alias)
      var kept = false
      val tag = (if (a.strongBox) "strongbox" else "tee") + (if (a.ids) "+ids" else "")
      try {
        val chain = generateAndReadChain(alias, challenge, a.strongBox, a.ids)
        val idState = when {
          !wantIds -> "not_requested"
          !idsSupported -> "unsupported"
          a.ids -> "included"
          a.strongBox in idsRefusedAt -> "refused"
          else -> "error"
        }
        val out = mutableMapOf<String, Any?>(
          "chain" to chain,
          "strongBox" to a.strongBox,
          "idAttestation" to idState,
          "claimed" to claimed,
        )
        if (idState == "error" && idError != null) out["idError"] = idError
        kept = keepAlias != null
        return out
      } catch (e: Exception) {
        // StrongBoxUnavailableException is API 28+; test it behind the guard so older devices never resolve it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && e is StrongBoxUnavailableException) {
          strongBoxGone = true
          errors.add("$tag: strongbox unavailable")
          continue
        }
        val text = describe(e)
        errors.add("$tag: $text")
        if (a.ids) {
          if (isIdAttestationRefusal(e)) idsRefusedAt.add(a.strongBox) else idError = idError ?: "$tag: $text"
        }
      } finally {
        if (!kept) deleteQuietly(alias)
      }
    }
    val idState = when {
      !wantIds -> "not_requested"
      !idsSupported -> "unsupported"
      idsRefusedAt.isNotEmpty() -> "refused"
      else -> "error"
    }
    return failure(errors.joinToString(" | ").ifEmpty { "attestation failed" }, idState, idError, claimed)
  }

  /**
   * True only for the device declining ID attestation: a SecurityException, a KeyStoreException
   * with ERROR_ID_ATTESTATION_FAILURE (API 33+), or a ProviderException/KeyStoreException whose
   * message names ID attestation (CANNOT_ATTEST_IDS). Anything else is reported as an error.
   */
  private fun isIdAttestationRefusal(e: Throwable): Boolean {
    var t: Throwable? = e
    var depth = 0
    while (t != null && depth < 8) {
      if (t is SecurityException) return true
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && t is KeyStoreException &&
        t.numericErrorCode == KeyStoreException.ERROR_ID_ATTESTATION_FAILURE
      ) return true
      val keystoreEx = t is java.security.KeyStoreException ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && t is KeyStoreException)
      if (t is ProviderException || keystoreEx) {
        val m = (t.message ?: "").lowercase()
        if ("attest_ids" in m || "id attestation" in m || "device id" in m || "attest ids" in m) return true
      }
      t = t.cause
      depth++
    }
    return false
  }

  /** Exception class + message for the whole cause chain, bounded. */
  private fun describe(e: Throwable): String {
    val parts = mutableListOf<String>()
    var t: Throwable? = e
    while (t != null && parts.size < 4) {
      parts.add("${t.javaClass.simpleName}: ${t.message}")
      t = t.cause
    }
    return parts.joinToString(" <- ").take(500)
  }

  private fun generateAndReadChain(alias: String, challenge: ByteArray, strongBox: Boolean, ids: Boolean): List<String> {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setAttestationChallenge(challenge)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    if (ids && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setDevicePropertiesAttestationIncluded(true)

    val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    kpg.initialize(builder.build())
    kpg.generateKeyPair()

    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val certs = ks.getCertificateChain(alias) ?: throw IllegalStateException("no certificate chain")
    if (certs.isEmpty()) throw IllegalStateException("empty certificate chain")
    // Leaf first, as the Keystore returns it and as the server expects.
    return certs.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
  }

  private fun deleteQuietly(alias: String) {
    try {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    } catch (_: Exception) {
      // best effort: the key is unused and holds nothing sensitive
    }
  }

  private fun failure(error: String, idState: String, idError: String?, claimed: Map<String, Any?>): Map<String, Any?> {
    val out = mutableMapOf<String, Any?>(
      "chain" to emptyList<String>(),
      "strongBox" to false,
      "idAttestation" to idState,
      "error" to error,
      "claimed" to claimed,
    )
    if (idError != null) out["idError"] = idError
    return out
  }
}
