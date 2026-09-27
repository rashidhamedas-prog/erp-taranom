package ir.taranom.crm.sales.update

/**
 * پارس‌کنندهٔ JSON حداقلی (object/array/string/number/bool/null) برای manifest.
 * عمداً بدون Gson/Moshi تا ماژول `:update` بدون وابستگی شبکه/اندروید بماند.
 */
internal object JsonLite {

    sealed class Node {
        data class Obj(val map: Map<String, Node>) : Node()
        data class Arr(val items: List<Node>) : Node()
        data class Str(val value: String) : Node()
        data class Num(val value: Double) : Node()
        data class Bool(val value: Boolean) : Node()
        data object Null : Node()

        fun asObject(): Map<String, Node>? = (this as? Obj)?.map
        fun asString(): String? = when (this) {
            is Str -> value
            is Num -> if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()
            is Bool -> value.toString()
            else -> null
        }
        fun asLong(): Long? = when (this) {
            is Num -> value.toLong()
            is Str -> value.toLongOrNull()
            else -> null
        }
    }

    fun objectMap(json: String): Map<String, Node> {
        val node = parse(json.trim())
        return node.asObject() ?: emptyMap()
    }

    fun parse(input: String): Node {
        val p = Parser(input)
        val node = p.parseValue()
        p.skipWs()
        if (!p.eof()) error("trailing_json")
        return node
    }

    private class Parser(private val s: String) {
        private var i = 0

        fun eof(): Boolean = i >= s.length

        fun skipWs() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun parseValue(): Node {
            skipWs()
            if (eof()) error("unexpected_eof")
            val c = s[i]
            return when {
                c == '{' -> parseObject()
                c == '[' -> parseArray()
                c == '"' -> Node.Str(parseString())
                c == 't' || c == 'f' -> parseBool()
                c == 'n' -> parseNull()
                c == '-' || c.isDigit() -> parseNumber()
                else -> error("unexpected_char:$c")
            }
        }

        private fun parseObject(): Node.Obj {
            expect('{')
            val map = linkedMapOf<String, Node>()
            skipWs()
            if (peek('}')) {
                i++
                return Node.Obj(map)
            }
            while (true) {
                skipWs()
                val key = parseString()
                skipWs()
                expect(':')
                map[key] = parseValue()
                skipWs()
                when {
                    peek(',') -> {
                        i++
                        continue
                    }
                    peek('}') -> {
                        i++
                        break
                    }
                    else -> error("object_separator")
                }
            }
            return Node.Obj(map)
        }

        private fun parseArray(): Node.Arr {
            expect('[')
            val items = mutableListOf<Node>()
            skipWs()
            if (peek(']')) {
                i++
                return Node.Arr(items)
            }
            while (true) {
                items += parseValue()
                skipWs()
                when {
                    peek(',') -> {
                        i++
                        continue
                    }
                    peek(']') -> {
                        i++
                        break
                    }
                    else -> error("array_separator")
                }
            }
            return Node.Arr(items)
        }

        private fun parseString(): String {
            expect('"')
            val sb = StringBuilder()
            while (!eof()) {
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        if (eof()) error("bad_escape")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> sb.append(e)
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) error("bad_unicode")
                                val hex = s.substring(i, i + 4)
                                sb.append(hex.toInt(16).toChar())
                                i += 4
                            }
                            else -> error("bad_escape:$e")
                        }
                    }
                    else -> sb.append(c)
                }
            }
            error("unterminated_string")
        }

        private fun parseNumber(): Node.Num {
            val start = i
            if (peek('-')) i++
            while (i < s.length && s[i].isDigit()) i++
            if (peek('.')) {
                i++
                while (i < s.length && s[i].isDigit()) i++
            }
            if (peek('e') || peek('E')) {
                i++
                if (peek('+') || peek('-')) i++
                while (i < s.length && s[i].isDigit()) i++
            }
            return Node.Num(s.substring(start, i).toDouble())
        }

        private fun parseBool(): Node.Bool = when {
            match("true") -> Node.Bool(true)
            match("false") -> Node.Bool(false)
            else -> error("bad_bool")
        }

        private fun parseNull(): Node.Null {
            if (!match("null")) error("bad_null")
            return Node.Null
        }

        private fun expect(c: Char) {
            skipWs()
            if (eof() || s[i] != c) error("expected:$c")
            i++
        }

        private fun peek(c: Char): Boolean = i < s.length && s[i] == c

        private fun match(token: String): Boolean {
            if (s.startsWith(token, i)) {
                i += token.length
                return true
            }
            return false
        }
    }
}
