package ir.taranom.crm.sales.sync.impl.crypto

/**
 * Canonical JSON matching `server/sync/device-auth.js` `stableJson()`.
 * Key order is sorted; unsupported values throw (fail closed).
 */
object StableJson {

    fun stringify(value: Any?): String = when (value) {
        null -> "null"
        is String -> jsonString(value)
        is Boolean -> if (value) "true" else "false"
        is Int -> value.toString()
        is Long -> value.toString()
        is Double -> {
            require(value.isFinite()) { "Replay envelope contains a non-finite number" }
            // Match JSON.stringify for integers stored as Double
            if (value % 1.0 == 0.0 && value in Long.MIN_VALUE.toDouble()..Long.MAX_VALUE.toDouble()) {
                value.toLong().toString()
            } else {
                value.toString()
            }
        }
        is Float -> {
            require(value.isFinite()) { "Replay envelope contains a non-finite number" }
            value.toDouble().let { stringify(it) }
        }
        is Number -> {
            val d = value.toDouble()
            require(d.isFinite()) { "Replay envelope contains a non-finite number" }
            stringify(d)
        }
        is List<*> -> "[" + value.joinToString(",") { stringify(it) } + "]"
        is Map<*, *> -> {
            val keys = value.keys.map { key ->
                require(key is String) { "Replay envelope object keys must be strings" }
                key
            }.sorted()
            "{" + keys.joinToString(",") { key ->
                val child = value[key]
                require(child !is Function<*>) { "Replay envelope contains an unsupported value" }
                "${jsonString(key)}:${stringify(child)}"
            } + "}"
        }
        else -> throw TypeError("Replay envelope contains an unsupported value: ${value::class}")
    }

    private fun jsonString(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) {
                    sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    private class TypeError(message: String) : IllegalArgumentException(message)
}
