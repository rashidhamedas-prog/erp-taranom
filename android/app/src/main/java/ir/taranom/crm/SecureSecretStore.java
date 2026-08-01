package ir.taranom.crm;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the embedded server JWT secret encrypted by a non-exportable AndroidKeyStore key. */
final class SecureSecretStore {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "erp_taranom_jwt_aes_gcm_v1";
    private static final String PREFS_NAME = "secure_secret_store_v1";
    private static final String PREF_CIPHERTEXT = "jwt_ciphertext";
    private static final String PREF_IV = "jwt_iv";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_LEGACY_SECRET_BYTES = 4096;
    private static final int MIN_SECRET_CHARS = 32;

    private SecureSecretStore() { }

    static synchronized String getOrCreateJwtSecret(Context context, File dataDir) throws Exception {
        if (context == null || dataDir == null) throw new IllegalArgumentException("context/dataDir required");
        Context appContext = context.getApplicationContext();
        SharedPreferences prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String encrypted = prefs.getString(PREF_CIPHERTEXT, null);
        String iv = prefs.getString(PREF_IV, null);
        File legacyFile = new File(dataDir, "jwt-secret");

        if ((encrypted == null) != (iv == null)) {
            throw new SecurityException("secure JWT metadata is incomplete");
        }
        if (encrypted != null) {
            String existing = decrypt(appContext, encrypted, iv);
            validateSecret(existing);
            eraseLegacyPlaintext(legacyFile, dataDir);
            return existing;
        }

        String candidate = readLegacySecret(legacyFile, dataDir);
        if (candidate == null || candidate.length() < MIN_SECRET_CHARS) {
            byte[] random = new byte[48];
            new SecureRandom().nextBytes(random);
            candidate = Base64.encodeToString(random, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
            Arrays.fill(random, (byte) 0);
        }
        validateSecret(candidate);
        encryptAndPersist(appContext, prefs, candidate);

        String verified = decrypt(
                appContext,
                prefs.getString(PREF_CIPHERTEXT, null),
                prefs.getString(PREF_IV, null));
        boolean persisted = MessageDigest.isEqual(
                candidate.getBytes(StandardCharsets.UTF_8),
                verified.getBytes(StandardCharsets.UTF_8));
        if (!persisted) throw new SecurityException("secure JWT persistence verification failed");

        eraseLegacyPlaintext(legacyFile, dataDir);
        return candidate;
    }

    private static void validateSecret(String secret) {
        if (secret == null || secret.length() < MIN_SECRET_CHARS || secret.length() > MAX_LEGACY_SECRET_BYTES) {
            throw new SecurityException("invalid local JWT secret");
        }
    }

    private static String readLegacySecret(File legacyFile, File dataDir) throws IOException {
        validateLegacyPath(legacyFile, dataDir);
        if (!legacyFile.exists()) return null;
        if (!legacyFile.isFile() || legacyFile.length() > MAX_LEGACY_SECRET_BYTES) {
            throw new SecurityException("invalid legacy JWT secret file");
        }
        byte[] bytes = new byte[(int) legacyFile.length()];
        try (FileInputStream input = new FileInputStream(legacyFile)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            if (offset != bytes.length) throw new IOException("legacy JWT secret read incomplete");
            return new String(bytes, StandardCharsets.UTF_8).trim();
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private static void encryptAndPersist(
            Context context, SharedPreferences prefs, String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        cipher.updateAAD(aad(context));
        byte[] plaintextBytes = plaintext.getBytes(StandardCharsets.UTF_8);
        byte[] encryptedBytes;
        try {
            encryptedBytes = cipher.doFinal(plaintextBytes);
        } finally {
            Arrays.fill(plaintextBytes, (byte) 0);
        }
        String encodedCiphertext = Base64.encodeToString(encryptedBytes, Base64.NO_WRAP);
        String encodedIv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        Arrays.fill(encryptedBytes, (byte) 0);
        boolean committed = prefs.edit()
                .putString(PREF_CIPHERTEXT, encodedCiphertext)
                .putString(PREF_IV, encodedIv)
                .commit();
        if (!committed) throw new IOException("secure JWT metadata commit failed");
    }

    private static String decrypt(Context context, String encrypted, String iv) throws Exception {
        if (encrypted == null || iv == null) throw new SecurityException("secure JWT metadata missing");
        byte[] encryptedBytes;
        byte[] ivBytes;
        try {
            encryptedBytes = Base64.decode(encrypted, Base64.NO_WRAP);
            ivBytes = Base64.decode(iv, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            throw new SecurityException("secure JWT metadata encoding invalid", e);
        }
        try {
            if (ivBytes.length != 12) throw new SecurityException("secure JWT IV invalid");
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, ivBytes));
            cipher.updateAAD(aad(context));
            byte[] plaintext = cipher.doFinal(encryptedBytes);
            try {
                return new String(plaintext, StandardCharsets.UTF_8);
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        } finally {
            Arrays.fill(encryptedBytes, (byte) 0);
            Arrays.fill(ivBytes, (byte) 0);
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build());
            generator.generateKey();
        }
        java.security.Key key = keyStore.getKey(KEY_ALIAS, null);
        if (!(key instanceof SecretKey)) throw new SecurityException("AndroidKeyStore JWT key unavailable");
        return (SecretKey) key;
    }

    private static byte[] aad(Context context) {
        return (context.getPackageName() + ":jwt:v1").getBytes(StandardCharsets.UTF_8);
    }

    private static void eraseLegacyPlaintext(File legacyFile, File dataDir) throws IOException {
        validateLegacyPath(legacyFile, dataDir);
        if (!legacyFile.exists()) return;
        if (!legacyFile.isFile() || legacyFile.length() > MAX_LEGACY_SECRET_BYTES) {
            throw new SecurityException("refusing to erase unexpected legacy JWT path");
        }
        try (RandomAccessFile file = new RandomAccessFile(legacyFile, "rw")) {
            long remaining = file.length();
            byte[] zeros = new byte[1024];
            file.seek(0);
            while (remaining > 0) {
                int count = (int) Math.min(remaining, zeros.length);
                file.write(zeros, 0, count);
                remaining -= count;
            }
            file.setLength(0);
            file.getFD().sync();
        }
        if (!legacyFile.delete() && legacyFile.exists()) {
            throw new IOException("legacy JWT secret deletion failed");
        }
    }

    private static void validateLegacyPath(File legacyFile, File dataDir) throws IOException {
        File canonicalDataDir = dataDir.getCanonicalFile();
        File canonicalLegacy = legacyFile.getCanonicalFile();
        if (!"jwt-secret".equals(canonicalLegacy.getName())
                || canonicalLegacy.getParentFile() == null
                || !canonicalDataDir.equals(canonicalLegacy.getParentFile())) {
            throw new SecurityException("legacy JWT path escaped app data directory");
        }
    }
}
