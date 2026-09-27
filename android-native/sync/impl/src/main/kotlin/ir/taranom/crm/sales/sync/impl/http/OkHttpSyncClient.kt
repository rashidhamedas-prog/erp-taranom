package ir.taranom.crm.sales.sync.impl.http

import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.sync.api.OpOutcome
import ir.taranom.crm.sales.sync.api.PairResult
import ir.taranom.crm.sales.sync.api.PullResult
import ir.taranom.crm.sales.sync.api.PulledRow
import ir.taranom.crm.sales.sync.api.PushResult
import ir.taranom.crm.sales.sync.api.SyncClient
import ir.taranom.crm.sales.sync.api.SyncEndpoints
import ir.taranom.crm.sales.sync.api.SyncNotAvailableException
import ir.taranom.crm.sales.sync.impl.CentralUrl
import ir.taranom.crm.sales.sync.impl.credentials.DeviceCredentialStore
import ir.taranom.crm.sales.sync.impl.credentials.MissingCredentialsException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * OkHttp client matching central wire protocol (Device HMAC + Ed25519 proofs).
 * Fail-closed when [credentials] are unpaired or secrets missing.
 */
class OkHttpSyncClient(
    private val credentials: DeviceCredentialStore,
    private val http: OkHttpClient = defaultClient(),
) : SyncClient {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    override suspend fun pair(
        centralUrl: String,
        username: String,
        password: String,
        deviceName: String,
    ): PairResult = withContext(Dispatchers.IO) {
        val base = CentralUrl.upgradeHttp(centralUrl)
        val publicKey = credentials.prepareSigningKeys()
        val body = buildJsonObject {
            put("username", username)
            put("password", password)
            put("device_name", deviceName)
            put("replay_public_key", publicKey)
        }.toString()
        val req = Request.Builder()
            .url("$base${SyncEndpoints.PAIR}")
            .post(body.toRequestBody(jsonMedia))
            .header("Content-Type", "application/json")
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrElse { JsonObject(emptyMap()) }
            if (!resp.isSuccessful) {
                throw SyncNotAvailableException(
                    obj["error"]?.jsonPrimitive?.contentOrNull ?: "اتصال به سرور مرکزی ناموفق بود",
                )
            }
            val deviceId = obj["device_id"]?.jsonPrimitive?.longOrNull
            val token = obj["device_token"]?.jsonPrimitive?.contentOrNull
            if (deviceId == null || token.isNullOrBlank()) {
                throw SyncNotAvailableException("پاسخ نامعتبر از سرور مرکزی — دوباره تلاش کنید")
            }
            credentials.savePairing(base, deviceId, token)
            PairResult(
                deviceId = deviceId,
                deviceToken = token,
                centralUrl = base,
                tokenExpiresAt = obj["token_expires_at"]?.jsonPrimitive?.longOrNull,
            )
        }
    }

    override suspend fun push(ops: List<OutboxOp>): PushResult = withContext(Dispatchers.IO) {
        requirePaired()
        if (ops.isEmpty()) return@withContext PushResult(emptyList())
        if (ops.any { it.replayProof.isNullOrBlank() }) {
            throw MissingCredentialsException(
                "عملیات قدیمی فاقد امضای معتبر است؛ اتصال دستگاه باید دوباره برقرار شود",
            )
        }
        val opsJson = buildJsonArray {
            for (op in ops) {
                add(
                    buildJsonObject {
                        put("seq", op.seq)
                        put("method", op.method)
                        put("path", op.path)
                        put("body", json.parseToJsonElement(op.bodyJson.ifBlank { "{}" }))
                        put("user_id", op.userId)
                        if (op.baseVersion != null) put("base_version", op.baseVersion)
                        if (op.entityTable != null) put("entity_table", op.entityTable)
                        if (op.entityLocalId != null) put("entity_local_id", op.entityLocalId)
                        put("replay_proof", op.replayProof!!)
                        put("file_hash", op.fileHash.orEmpty())
                        put("file_field", op.fileField.orEmpty())
                    },
                )
            }
        }
        val payload = buildJsonObject { put("ops", opsJson) }.toString()
        val respObj = authedJson("POST", SyncEndpoints.PUSH, payload)
        val results = respObj["results"]?.jsonArray ?: JsonArray(emptyList())
        val outcomes = mutableListOf<OpOutcome>()
        var stopped: Long? = null
        for (el in results) {
            val r = el.jsonObject
            val seq = r["seq"]?.jsonPrimitive?.longOrNull ?: continue
            when (r["status"]?.jsonPrimitive?.contentOrNull) {
                "applied" -> {
                    val result = r["result"]?.jsonObject
                    val centralId = result?.get("id")?.jsonPrimitive?.longOrNull
                    val num = result?.get("num")?.jsonPrimitive?.contentOrNull
                    val map = if (centralId != null) {
                        val local = ops.find { it.seq == seq }?.entityLocalId
                        if (local != null) mapOf(local to centralId) else emptyMap()
                    } else emptyMap()
                    outcomes += OpOutcome.Accepted(
                        seq = seq,
                        centralIds = map,
                        assignedDocumentNumber = num,
                        resultJson = result?.toString(),
                    )
                }
                "conflict" -> {
                    outcomes += OpOutcome.Conflict(
                        seq = seq,
                        reason = r["reason"]?.jsonPrimitive?.contentOrNull ?: "تعارض",
                    )
                    stopped = seq
                    break
                }
                "deferred" -> {
                    outcomes += OpOutcome.Deferred(
                        seq = seq,
                        reason = r["reason"]?.jsonPrimitive?.contentOrNull ?: "به تعویق افتاد",
                    )
                    stopped = seq
                    break
                }
            }
        }
        PushResult(outcomes, stopped)
    }

    override suspend fun pull(sinceSyncSeq: Long, limit: Int): PullResult = withContext(Dispatchers.IO) {
        requirePaired()
        val path = "${SyncEndpoints.PULL}?since=$sinceSyncSeq&limit=$limit"
        val obj = authedJson("GET", path, null)
        val changes = obj["changes"]?.jsonArray ?: JsonArray(emptyList())
        val rows = changes.mapNotNull { el ->
            val c = el.jsonObject
            val tbl = c["tbl"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val seq = c["seq"]?.jsonPrimitive?.longOrNull ?: 0L
            val del = c["del"]
            if (del != null && del !is JsonNull) {
                PulledRow(
                    table = tbl,
                    primaryKey = when (del) {
                        is JsonPrimitive -> del.content
                        else -> del.toString()
                    },
                    syncSeq = seq,
                    json = null,
                    deleted = true,
                )
            } else {
                val row = c["row"]?.jsonObject
                val pk = row?.get("id")?.jsonPrimitive?.contentOrNull ?: ""
                PulledRow(
                    table = tbl,
                    primaryKey = pk,
                    syncSeq = seq,
                    json = row?.toString(),
                    deleted = false,
                )
            }
        }
        val hasMore = obj["has_more"]?.let { el ->
            (el as? JsonPrimitive)?.booleanOrNull
                ?: (el as? JsonPrimitive)?.contentOrNull?.equals("true", true)
        } ?: false
        PullResult(
            rows = rows,
            nextSyncSeq = obj["next_since"]?.jsonPrimitive?.longOrNull ?: sinceSyncSeq,
            hasMore = hasMore == true,
        )
    }

    override suspend fun fetchRow(table: String, primaryKey: String): PulledRow? = withContext(Dispatchers.IO) {
        requirePaired()
        val path = "${SyncEndpoints.ROW}?tbl=$table&id=$primaryKey"
        val obj = authedJson("GET", path, null)
        val row = obj["row"] ?: return@withContext null
        if (row is JsonNull) return@withContext null
        val jo = row.jsonObject
        PulledRow(
            table = table,
            primaryKey = primaryKey,
            syncSeq = jo["sync_seq"]?.jsonPrimitive?.longOrNull ?: 0L,
            json = jo.toString(),
            deleted = false,
        )
    }

    override suspend fun downloadFile(subdir: String, fileName: String): ByteArray = withContext(Dispatchers.IO) {
        requirePaired()
        val path = "${SyncEndpoints.FILES}?path=${subdir.trim('/')}/$fileName"
        val req = authedRequest("GET", path, null)
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw SyncNotAvailableException("فایل یافت نشد ($subdir/$fileName)")
            }
            resp.body?.bytes() ?: ByteArray(0)
        }
    }

    override suspend fun replayMultipart(
        op: OutboxOp,
        fileBytes: ByteArray,
        fileName: String,
    ): OpOutcome = withContext(Dispatchers.IO) {
        requirePaired()
        val proof = op.replayProof
            ?: throw MissingCredentialsException("replay_proof missing")
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("path", op.path)
            .addFormDataPart("method", op.method)
            .addFormDataPart("user_id", op.userId.toString())
            .addFormDataPart("field", op.fileField ?: "file")
            .addFormDataPart("seq", op.seq.toString())
            .addFormDataPart("replay_proof", proof)
            .addFormDataPart("body_json", op.bodyJson)
            .addFormDataPart(
                "file",
                fileName,
                fileBytes.toRequestBody("application/octet-stream".toMediaType()),
            )
            .build()
        val request = Request.Builder()
            .url(requireBase() + SyncEndpoints.REPLAY_MULTIPART)
            .headers(deviceHeaders())
            .post(multipart)
            .build()
        http.newCall(request).execute().use { resp ->
            if (resp.isSuccessful) {
                OpOutcome.Accepted(op.seq)
            } else {
                val text = resp.body?.string().orEmpty()
                val err = runCatching {
                    json.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.contentOrNull
                }.getOrNull()
                OpOutcome.Conflict(op.seq, err ?: "بازپخش فایل ناموفق")
            }
        }
    }

    private fun requirePaired() {
        if (!credentials.isPaired) {
            throw SyncNotAvailableException("دستگاه هنوز به سرور مرکزی متصل نشده است")
        }
    }

    private fun requireBase(): String =
        credentials.centralUrl ?: throw SyncNotAvailableException("central_url missing")

    private fun deviceHeaders(): okhttp3.Headers {
        val auth = credentials.authorizationHeader()
            ?: throw MissingCredentialsException("device credentials missing")
        val ts = credentials.nowEpochSeconds()
        val nonce = credentials.freshNonce()
        require(nonce.matches(Regex("^[a-f0-9]{36}$"))) { "invalid nonce" }
        val sig = credentials.hmacSignature(ts, nonce)
        return okhttp3.Headers.Builder()
            .add(SyncEndpoints.Headers.AUTHORIZATION, auth)
            .add(SyncEndpoints.Headers.TIME, ts.toString())
            .add(SyncEndpoints.Headers.NONCE, nonce)
            .add(SyncEndpoints.Headers.SIGNATURE, sig)
            .build()
    }

    private fun authedRequest(method: String, path: String, body: String?): Request {
        val url = requireBase() + path
        val b = Request.Builder().url(url).headers(deviceHeaders())
        return when (method) {
            "GET" -> b.get().build()
            "POST" -> b.post((body ?: "{}").toRequestBody(jsonMedia)).build()
            else -> throw IllegalArgumentException(method)
        }
    }

    private fun authedJson(method: String, path: String, body: String?): JsonObject {
        val req = authedRequest(method, path, body)
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }
                .getOrElse { JsonObject(emptyMap()) }
            if (resp.code == 401) {
                throw MissingCredentialsException(
                    obj["error"]?.jsonPrimitive?.contentOrNull ?: "اعتبار دستگاه نامعتبر است",
                )
            }
            if (!resp.isSuccessful) {
                throw SyncNotAvailableException(
                    obj["error"]?.jsonPrimitive?.contentOrNull ?: "خطای همگام‌سازی HTTP ${resp.code}",
                )
            }
            return obj
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .build()

        /** Probe central liveness (no device auth). */
        fun probe(http: OkHttpClient, centralUrl: String): Boolean {
            return try {
                val base = CentralUrl.upgradeHttp(centralUrl)
                val req = Request.Builder().url("$base/api/system/time").get().build()
                http.newCall(req).execute().use { it.isSuccessful }
            } catch (_: Exception) {
                false
            }
        }
    }
}
