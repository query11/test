using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace ClaudeDesktopManager
{
    public static class ProxyLogic
    {
        public const string PolicyUrlKey = "egressProxyUrl";
        public const string PolicyPacKey = "egressProxyPacUrl";

        public static readonly string[] Schemes = { "http", "https", "socks5", "socks4" };

        /// <summary>Problems that make the proxy settings unusable (empty = fine).</summary>
        public static List<string> Validate(ProxySettings p)
        {
            var errors = new List<string>();
            if (p.Mode == ProxyMode.Manual)
            {
                if (!Schemes.Contains(p.Scheme)) errors.Add("不支持的代理协议：" + p.Scheme);
                var host = (p.Host ?? "").Trim();
                if (host.Length == 0) errors.Add("请填写代理服务器地址");
                else if (host.Contains("://")) errors.Add("代理地址只填主机名或 IP，不要带 http:// 前缀");
                else if (host.Contains("@")) errors.Add("代理地址不能带用户名密码（Claude Desktop 不支持代理登录，请改用本机无密码的转发端口）");
                else if (host.Any(c => char.IsWhiteSpace(c) || c == '/' || c == '?' || c == '#' || c == ';' || c == ','))
                    errors.Add("代理地址里有不允许的字符");
                if (p.Port < 1 || p.Port > 65535) errors.Add("端口应在 1–65535 之间");
            }
            else if (p.Mode == ProxyMode.Pac)
            {
                var url = (p.PacUrl ?? "").Trim();
                if (url.Length == 0) errors.Add("请填写 PAC 脚本地址");
                else if (!(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                    errors.Add("PAC 地址应以 http:// 或 https:// 开头");
            }
            return errors;
        }

        /// <summary>Things that work but may not do what the user expects.</summary>
        public static List<string> Warnings(ProxySettings p, bool supportsEnv)
        {
            var w = new List<string>();
            if (p.Mode == ProxyMode.System) return w;
            if (p.ViaPolicy)
            {
                if (p.Mode == ProxyMode.Manual && p.Scheme.StartsWith("socks", StringComparison.Ordinal))
                    w.Add("官方策略 egressProxyUrl 只支持 HTTP/HTTPS 代理，SOCKS 代理不会写入策略");
                if (p.Mode == ProxyMode.Direct)
                    w.Add("官方策略没有“直连”选项；选“不使用代理”时只会删除本工具写过的策略");
            }
            if (p.Mode == ProxyMode.Manual && p.Scheme.StartsWith("socks", StringComparison.Ordinal))
                w.Add("Claude Code 引擎只认 HTTP 代理，SOCKS 代理只对 Claude 窗口本身生效；能用 HTTP（混合端口）的话更稳");
            if (!p.ViaLaunchFlags && !p.ViaPolicy && !(p.ViaEnv && supportsEnv))
                w.Add("没有勾选任何应用方式，这个代理设置不会生效");
            return w;
        }

        /// <summary>Host part usable in a URL (IPv6 gets brackets).</summary>
        public static string UrlHost(string host)
        {
            host = (host ?? "").Trim();
            if (host.Contains(":") && !host.StartsWith("[", StringComparison.Ordinal)) return "[" + host + "]";
            return host;
        }

        public static string ProxyUrl(ProxySettings p) =>
            p.Scheme + "://" + UrlHost(p.Host) + ":" + p.Port.ToString(CultureInfo.InvariantCulture);

        /// <summary>User bypass entries, split on ; , and whitespace.</summary>
        public static List<string> BypassEntries(string bypass) =>
            (bypass ?? "").Split(new[] { ';', ',', ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Where(s => s.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        /// <summary>Chromium command-line switches for the proxy.</summary>
        public static List<string> ChromiumArgs(ProxySettings p)
        {
            var args = new List<string>();
            if (!p.ViaLaunchFlags) return args;
            switch (p.Mode)
            {
                case ProxyMode.Direct:
                    args.Add("--no-proxy-server");
                    break;
                case ProxyMode.Manual:
                    args.Add("--proxy-server=" + ProxyUrl(p));
                    var bypass = BypassEntries(p.Bypass);
                    // <local> keeps intranet names direct; loopback is always direct in Chromium.
                    bypass.Insert(0, "<local>");
                    args.Add("--proxy-bypass-list=" + string.Join(";", bypass.Distinct(StringComparer.OrdinalIgnoreCase)));
                    break;
                case ProxyMode.Pac:
                    args.Add("--proxy-pac-url=" + p.PacUrl.Trim());
                    break;
            }
            return args;
        }

        /// <summary>Proxy environment variables for child processes (MCP servers, the Claude Code engine).</summary>
        public static Dictionary<string, string> EnvVars(ProxySettings p)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!p.ViaEnv) return env;
            if (p.Mode == ProxyMode.Manual)
            {
                var noProxy = new List<string> { "localhost", "127.0.0.1", "::1" };
                noProxy.AddRange(BypassEntries(p.Bypass).Where(e => e != "<local>"));
                if (p.Scheme.StartsWith("socks", StringComparison.Ordinal))
                {
                    env["ALL_PROXY"] = ProxyUrl(p);
                }
                else
                {
                    var url = ProxyUrl(p);
                    env["HTTP_PROXY"] = url;
                    env["HTTPS_PROXY"] = url;
                }
                env["NO_PROXY"] = string.Join(",", noProxy.Distinct(StringComparer.OrdinalIgnoreCase));
            }
            else if (p.Mode == ProxyMode.Direct)
            {
                // Explicitly empty, so an inherited system-wide variable does not sneak in.
                env["HTTP_PROXY"] = "";
                env["HTTPS_PROXY"] = "";
                env["ALL_PROXY"] = "";
            }
            return env;
        }

        /// <summary>
        /// Desired values of the two official policy keys: a value to write, or null to delete.
        /// Returns null when the profile does not want the policy touched at all.
        /// </summary>
        public static Dictionary<string, string> DesiredPolicy(ProxySettings p, bool weOwnPolicy)
        {
            bool wants = p.ViaPolicy && (p.Mode == ProxyMode.Pac
                || (p.Mode == ProxyMode.Manual && (p.Scheme == "http" || p.Scheme == "https")));
            if (wants)
            {
                return new Dictionary<string, string>
                {
                    [PolicyUrlKey] = p.Mode == ProxyMode.Manual ? p.Scheme + "://" + UrlHost(p.Host) + ":" + p.Port.ToString(CultureInfo.InvariantCulture) : null,
                    [PolicyPacKey] = p.Mode == ProxyMode.Pac ? p.PacUrl.Trim() : null,
                };
            }
            // Only clean up what we wrote ourselves; a policy set by an administrator stays.
            if (weOwnPolicy) return new Dictionary<string, string> { [PolicyUrlKey] = null, [PolicyPacKey] = null };
            return null;
        }

        public static string Describe(ProxySettings p)
        {
            switch (p.Mode)
            {
                case ProxyMode.Direct: return "不使用代理";
                case ProxyMode.Manual: return ProxyUrl(p);
                case ProxyMode.Pac: return "PAC " + p.PacUrl;
                default: return "跟随系统";
            }
        }
    }

    public sealed class LaunchSpec
    {
        public List<string> Args = new List<string>();
        public Dictionary<string, string> Env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public List<string> Errors = new List<string>();
        public List<string> Warnings = new List<string>();

        public string ArgString => CommandLine.Join(Args);
    }

    public static class LaunchBuilder
    {
        public static LaunchSpec Build(Profile p, bool supportsEnv)
        {
            var spec = new LaunchSpec();
            spec.Errors.AddRange(ProxyLogic.Validate(p.Proxy));
            spec.Warnings.AddRange(ProxyLogic.Warnings(p.Proxy, supportsEnv));
            spec.Args.AddRange(ProxyLogic.ChromiumArgs(p.Proxy));
            if (!string.IsNullOrWhiteSpace(p.Lang))
            {
                var lang = p.Lang.Trim();
                if (lang.Any(c => !(char.IsLetterOrDigit(c) || c == '-' || c == '_')))
                    spec.Errors.Add("语言代码格式不对：" + lang);
                else spec.Args.Add("--lang=" + lang);
            }
            if (p.DisableGpu) spec.Args.Add("--disable-gpu");
            List<string> extra;
            try { extra = CommandLine.Split(p.ExtraArgs ?? ""); }
            catch (FormatException e) { extra = new List<string>(); spec.Errors.Add("额外启动参数：" + e.Message); }
            spec.Args.AddRange(extra);

            if (supportsEnv)
            {
                foreach (var kv in ProxyLogic.EnvVars(p.Proxy)) spec.Env[kv.Key] = kv.Value;
            }
            var envLines = ParseEnvLines(p.ExtraEnv, out var envErrors);
            spec.Errors.AddRange(envErrors);
            if (envLines.Count > 0)
            {
                if (supportsEnv) foreach (var kv in envLines) spec.Env[kv.Key] = kv.Value;
                else spec.Warnings.Add("MSIX 版无法附带环境变量，“额外环境变量”不会生效");
            }
            return spec;
        }

        public static List<KeyValuePair<string, string>> ParseEnvLines(string text, out List<string> errors)
        {
            errors = new List<string>();
            var list = new List<KeyValuePair<string, string>>();
            int lineNo = 0;
            foreach (var raw in (text ?? "").Split('\n'))
            {
                lineNo++;
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0)
                {
                    errors.Add("环境变量第 " + lineNo + " 行应为 名称=值");
                    continue;
                }
                var name = line.Substring(0, eq).Trim();
                if (name.Any(c => char.IsWhiteSpace(c) || c == '=' || c == '\0'))
                {
                    errors.Add("环境变量第 " + lineNo + " 行的名称不合法：" + name);
                    continue;
                }
                list.Add(new KeyValuePair<string, string>(name, line.Substring(eq + 1).Trim()));
            }
            return list;
        }
    }

    /// <summary>Windows command-line quoting compatible with CommandLineToArgvW / the MSVC runtime.</summary>
    public static class CommandLine
    {
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string Join(IEnumerable<string> args) => string.Join(" ", args.Select(Quote));

        /// <summary>Splits text the way CommandLineToArgvW would (for arguments after the program name).</summary>
        public static List<string> Split(string text)
        {
            var result = new List<string>();
            var cur = new StringBuilder();
            bool inQuotes = false, hasToken = false;
            int i = 0;
            while (i < text.Length)
            {
                char c = text[i];
                if (c == '\\')
                {
                    int n = 0;
                    while (i < text.Length && text[i] == '\\') { n++; i++; }
                    if (i < text.Length && text[i] == '"')
                    {
                        cur.Append('\\', n / 2);
                        if (n % 2 == 1) { cur.Append('"'); i++; }
                    }
                    else cur.Append('\\', n);
                    hasToken = true;
                    continue;
                }
                if (c == '"')
                {
                    if (inQuotes && i + 1 < text.Length && text[i + 1] == '"')
                    {
                        cur.Append('"');
                        i += 2;
                        continue;
                    }
                    inQuotes = !inQuotes;
                    hasToken = true;
                    i++;
                    continue;
                }
                if (!inQuotes && (c == ' ' || c == '\t' || c == '\r' || c == '\n'))
                {
                    if (hasToken) { result.Add(cur.ToString()); cur.Clear(); hasToken = false; }
                    i++;
                    continue;
                }
                cur.Append(c);
                hasToken = true;
                i++;
            }
            if (inQuotes) throw new FormatException("引号没有配对");
            if (hasToken) result.Add(cur.ToString());
            return result;
        }
    }
}
