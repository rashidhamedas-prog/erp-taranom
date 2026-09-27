package ir.taranom.crm.sales.sync.impl.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Parse outbox body JSON into a Map tree suitable for [StableJson] / replay envelopes. */
object JsonMaps {
    private val json = Json { ignoreUnknownKeys = true }

    fun parseObject(bodyJson: String): Map<String, Any?> {
        val el = json.parseToJsonElement(bodyJson.ifBlank { "{}" })
        require(el is JsonObject) { "Replay envelope body must be a JSON object" }
        @Suppress("UNCHECKED_CAST")
        return toKotlin(el) as Map<String, Any?>
    }

    private fun toKotlin(el: JsonElement): Any? = when (el) {
        is JsonNull -> null
        is JsonPrimitive -> {
            when {
                el.isString -> el.content
                el.booleanOrNull != null -> el.booleanOrNull
                el.longOrNull != null -> {
                    val asLong = el.longOrNull!!
                    val asDouble = el.doubleOrNull
                    if (asDouble != null && asDouble % 1.0 != 0.0) asDouble else asLong
                }
                el.doubleOrNull != null -> el.doubleOrNull
                else -> el.contentOrNull
            }
        }
        is JsonArray -> el.map { toKotlin(it) }
        is JsonObject -> el.mapValues { (_, v) -> toKotlin(v) }
    }
}
