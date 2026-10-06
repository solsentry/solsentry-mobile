package app.solsentry.deviceattestation

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * Hardware key attestation for the optional "Device check".
 *
 * Generates a throwaway EC P-256 key in the Android Keystore with the caller's challenge,
 * reads the attestation certificate chain, then deletes the key. Nothing else is touched:
 * no serial, no IMEI/MEID (setDevicePropertiesAttestationIncluded only covers brand,
 * device, product, manufacturer and model), no permissions.
 */
class DeviceAttestationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceAttestation")

    // Runs off the JS and UI threads (Expo AsyncFunction queue); key generation can take seconds.
    AsyncFunction("attestKey") { challengeB64: String, opts: Map<String, Any?> ->
      attest(challengeB64, opts["strongBox"] == true, opts["includeDeviceIds"] == true)
    }
  }

  private class Attempt(val strongBox: Boolean, val ids: Boolean)

  private fun attest(challengeB64: String, wantStrongBox: Boolean, wantIds: Boolean): Map<String, Any?> {
    val claimed = mapOf(
      "manufacturer" to Build.MANUFACTURER,
      "brand" to Build.BRAND,
      "model" to Build.MODEL,
      "sdkInt" to Build.VERSION.SDK_INT,
    )
    val challenge = try {
      Base64.decode(challengeB64, Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
      return failure("bad challenge: ${e.message}", "unsupported", claimed)
    }
    if (challenge.isEmpty() || challenge.size > 128) {
      return failure("challenge must be 1..128 bytes", "unsupported", claimed)
    }

    val idsSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val tryIds = wantIds && idsSupported
    val tryStrongBox = wantStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    var idsRefused = false

    // StrongBox first (if asked), then TEE; at each level with IDs first (if asked), then without.
    val plan = mutableListOf<Attempt>()
    for (sb in if (tryStrongBox) listOf(true, false) else listOf(false)) {
      if (tryIds) plan.add(Attempt(sb, true))
      plan.add(Attempt(sb, false))
    }

    var lastError: String? = null
    var strongBoxGone = false
    for (a in plan) {
      if (a.strongBox && strongBoxGone) continue
      if (a.ids && idsRefused) continue
      val alias = "solsentry_attest_" + UUID.randomUUID().toString()
      try {
        val chain = generateAndReadChain(alias, challenge, a.strongBox, a.ids)
        val idState = when {
          !idsSupported || !wantIds -> "unsupported"
          a.ids -> "included"
          else -> "refused"
        }
        return mapOf(
          "chain" to chain,
          "strongBox" to a.strongBox,
          "idAttestation" to idState,
          "claimed" to claimed,
        )
      } catch (e: StrongBoxUnavailableException) {
        strongBoxGone = true
        lastError = "strongbox unavailable"
      } catch (e: Exception) {
        // With IDs requested, a failure is most often the device refusing ID attestation
        // (ProviderException / CANNOT_ATTEST_IDS). Retry the same level without IDs.
        if (a.ids) idsRefused = true
        lastError = "${e.javaClass.simpleName}: ${e.message}"
      } finally {
        deleteQuietly(alias)
      }
    }
    return failure(lastError ?: "attestation failed", if (wantIds && idsSupported) "refused" else "unsupported", claimed)
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

  private fun failure(error: String, idState: String, claimed: Map<String, Any?>): Map<String, Any?> = mapOf(
    "chain" to emptyList<String>(),
    "strongBox" to false,
    "idAttestation" to idState,
    "error" to error,
    "claimed" to claimed,
  )
}
