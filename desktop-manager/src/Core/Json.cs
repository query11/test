using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ClaudeDesktopManager
{
    /// <summary>
    /// JSON object that keeps key order, so rewriting claude_desktop_config.json
    /// leaves everything we did not touch where it was.
    /// </summary>
    public sealed class JsonObject : IEnumerable<KeyValuePair<string, object>>
    {
        readonly List<KeyValuePair<string, object>> items = new List<KeyValuePair<string, object>>();

        public int Count => items.Count;

        public IEnumerable<string> Keys
        {
            get { foreach (var kv in items) yield return kv.Key; }
        }

        public object this[string key]
        {
            get { return TryGet(key, out var v) ? v : null; }
            set { Set(key, value); }
        }

        public bool TryGet(string key, out object value)
        {
            int i = IndexOf(key);
            value = i >= 0 ? items[i].Value : null;
            return i >= 0;
        }

        public bool ContainsKey(string key) => IndexOf(key) >= 0;

        /// <summary>Replaces the value in place, or appends the key.</summary>
        public JsonObject Set(string key, object value)
        {
            int i = IndexOf(key);
            if (i >= 0) items[i] = new KeyValuePair<string, object>(key, value);
            else items.Add(new KeyValuePair<string, object>(key, value));
            return this;
        }

        public bool Remove(string key)
        {
            int i = IndexOf(key);
            if (i < 0) return false;
            items.RemoveAt(i);
            return true;
        }

        int IndexOf(string key)
        {
            for (int i = 0; i < items.Count; i++)
                if (items[i].Key == key) return i;
            return -1;
        }

        public string GetString(string key, string def = null)
        {
            var v = this[key];
            if (v is string s) return s;
            if (v is JsonNumber n) return n.Raw;
            if (v is bool b) return b ? "true" : "false";
            return def;
        }

        public bool GetBool(string key, bool def = false)
        {
            var v = this[key];
            if (v is bool b) return b;
            if (v is string s && bool.TryParse(s, out var p)) return p;
            if (v is JsonNumber n) return n.ToDouble() != 0;
            return def;
        }

        public int GetInt(string key, int def = 0)
        {
            var v = this[key];
            if (v is JsonNumber n && long.TryParse(n.Raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l)
                && l >= int.MinValue && l <= int.MaxValue) return (int)l;
            if (v is JsonNumber d) return (int)Math.Round(d.ToDouble());
            if (v is string s && int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) return i;
            return def;
        }

        public JsonObject GetObject(string key) => this[key] as JsonObject;

        public List<object> GetArray(string key) => this[key] as List<object>;

        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() => items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => items.GetEnumerator();
    }

    /// <summary>A number kept as its source text, so 1.0 and 1e3 survive a round trip unchanged.</summary>
    public sealed class JsonNumber
    {
        public readonly string Raw;

        public JsonNumber(string raw) { Raw = raw; }

        public JsonNumber(long value) { Raw = value.ToString(CultureInfo.InvariantCulture); }

        public double ToDouble() =>
            double.TryParse(Raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;

        public override string ToString() => Raw;

        public override bool Equals(object obj) => obj is JsonNumber n && n.Raw == Raw;

        public override int GetHashCode() => Raw.GetHashCode();
    }

    public sealed class JsonException : Exception
    {
        public readonly int Line, Column;

        public JsonException(string message, int line, int column)
            : base(string.Format("{0}（第 {1} 行第 {2} 列）", message, line, column))
        {
            Line = line;
            Column = column;
        }
    }

    /// <summary>
    /// Values are JsonObject, List&lt;object&gt;, string, JsonNumber, bool or null.
    /// Serialize also accepts int / long / double for convenience.
    /// </summary>
    public static class Json
    {
        public static object Parse(string text)
        {
            var p = new Parser(text ?? "");
            p.SkipWs();
            var v = p.ReadValue(0);
            p.SkipWs();
            if (!p.AtEnd) p.Fail("JSON 结束后还有多余的内容");
            return v;
        }

        public static JsonObject ParseObject(string text)
        {
            var v = Parse(text);
            if (v is JsonObject o) return o;
            throw new JsonException("顶层不是 JSON 对象", 1, 1);
        }

        public static string Serialize(object value, bool indent = true)
        {
            var sb = new StringBuilder();
            Write(sb, value, indent, 0);
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object v, bool indent, int depth)
        {
            switch (v)
            {
                case null:
                    sb.Append("null");
                    break;
                case string s:
                    WriteString(sb, s);
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case JsonNumber n:
                    sb.Append(n.Raw);
                    break;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    break;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    break;
                case double d:
                    if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                    else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case JsonObject o:
                    if (o.Count == 0) { sb.Append("{}"); break; }
                    sb.Append('{');
                    bool first = true;
                    foreach (var kv in o)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        NewLine(sb, indent, depth + 1);
                        WriteString(sb, kv.Key);
                        sb.Append(indent ? ": " : ":");
                        Write(sb, kv.Value, indent, depth + 1);
                    }
                    NewLine(sb, indent, depth);
                    sb.Append('}');
                    break;
                case IList list:
                    if (list.Count == 0) { sb.Append("[]"); break; }
                    sb.Append('[');
                    for (int k = 0; k < list.Count; k++)
                    {
                        if (k > 0) sb.Append(',');
                        NewLine(sb, indent, depth + 1);
                        Write(sb, list[k], indent, depth + 1);
                    }
                    NewLine(sb, indent, depth);
                    sb.Append(']');
                    break;
                default:
                    throw new ArgumentException("无法序列化的类型：" + v.GetType().Name);
            }
        }

        static void NewLine(StringBuilder sb, bool indent, int depth)
        {
            if (!indent) return;
            sb.Append('\n');
            sb.Append(' ', depth * 2);
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029)
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        sealed class Parser
        {
            readonly string s;
            int pos;

            public Parser(string text)
            {
                s = text;
                // A UTF-8 BOM decoded as text shows up as U+FEFF; JSON.parse in Electron
                // would reject it, but a hand-edited file may have one, so skip it.
                if (s.Length > 0 && s[0] == '﻿') pos = 1;
            }

            public bool AtEnd => pos >= s.Length;

            public void Fail(string message)
            {
                int line = 1, col = 1;
                for (int i = 0; i < pos && i < s.Length; i++)
                {
                    if (s[i] == '\n') { line++; col = 1; }
                    else col++;
                }
                throw new JsonException(message, line, col);
            }

            public void SkipWs()
            {
                while (pos < s.Length)
                {
                    char c = s[pos];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                    else break;
                }
            }

            public object ReadValue(int depth)
            {
                if (depth > 512) Fail("嵌套太深");
                if (AtEnd) Fail("意外的文件结尾");
                char c = s[pos];
                switch (c)
                {
                    case '{': return ReadObject(depth);
                    case '[': return ReadArray(depth);
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                        Fail("无法识别的字符 '" + c + "'");
                        return null;
                }
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(s, pos, word, 0, word.Length) != 0) Fail("应为 " + word);
                pos += word.Length;
            }

            JsonObject ReadObject(int depth)
            {
                var o = new JsonObject();
                pos++;
                SkipWs();
                if (!AtEnd && s[pos] == '}') { pos++; return o; }
                while (true)
                {
                    SkipWs();
                    if (AtEnd || s[pos] != '"') Fail("应为用引号括起来的键名");
                    string key = ReadString();
                    SkipWs();
                    if (AtEnd || s[pos] != ':') Fail("键名后面应为冒号");
                    pos++;
                    SkipWs();
                    o.Set(key, ReadValue(depth + 1));
                    SkipWs();
                    if (AtEnd) Fail("对象没有结束");
                    if (s[pos] == ',') { pos++; continue; }
                    if (s[pos] == '}') { pos++; return o; }
                    Fail("对象成员之间应为逗号");
                }
            }

            List<object> ReadArray(int depth)
            {
                var list = new List<object>();
                pos++;
                SkipWs();
                if (!AtEnd && s[pos] == ']') { pos++; return list; }
                while (true)
                {
                    SkipWs();
                    list.Add(ReadValue(depth + 1));
                    SkipWs();
                    if (AtEnd) Fail("数组没有结束");
                    if (s[pos] == ',') { pos++; continue; }
                    if (s[pos] == ']') { pos++; return list; }
                    Fail("数组元素之间应为逗号");
                }
            }

            string ReadString()
            {
                pos++;
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd) Fail("字符串没有结束");
                    char c = s[pos++];
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        if (AtEnd) Fail("字符串没有结束");
                        char e = s[pos++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (pos + 4 > s.Length) Fail("\\u 转义不完整");
                                if (!int.TryParse(s.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int code))
                                    Fail("\\u 转义不是十六进制");
                                sb.Append((char)code);
                                pos += 4;
                                break;
                            default:
                                pos--;
                                Fail("无效的转义 \\" + e);
                                break;
                        }
                    }
                    else if (c < 0x20)
                    {
                        pos--;
                        Fail("字符串里不能有未转义的控制字符");
                    }
                    else sb.Append(c);
                }
            }

            JsonNumber ReadNumber()
            {
                int start = pos;
                if (s[pos] == '-') pos++;
                if (AtEnd) Fail("数字不完整");
                if (s[pos] == '0') pos++;
                else if (s[pos] >= '1' && s[pos] <= '9') { while (!AtEnd && s[pos] >= '0' && s[pos] <= '9') pos++; }
                else Fail("数字不完整");
                if (!AtEnd && s[pos] == '.')
                {
                    pos++;
                    if (AtEnd || s[pos] < '0' || s[pos] > '9') Fail("小数点后应为数字");
                    while (!AtEnd && s[pos] >= '0' && s[pos] <= '9') pos++;
                }
                if (!AtEnd && (s[pos] == 'e' || s[pos] == 'E'))
                {
                    pos++;
                    if (!AtEnd && (s[pos] == '+' || s[pos] == '-')) pos++;
                    if (AtEnd || s[pos] < '0' || s[pos] > '9') Fail("指数部分应为数字");
                    while (!AtEnd && s[pos] >= '0' && s[pos] <= '9') pos++;
                }
                return new JsonNumber(s.Substring(start, pos - start));
            }
        }
    }
}
