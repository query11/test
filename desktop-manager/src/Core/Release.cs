using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudeDesktopManager
{
    /// <summary>Where the official Windows builds of Claude Desktop come from, and how to tell them apart.</summary>
    public static class ClaudeRelease
    {
        public const string DownloadPage = "https://claude.com/download";
        /// <summary>Publisher id of the official package family, Claude_pzs8sxrjxfjjc.</summary>
        public const string PublisherId = "pzs8sxrjxfjjc";

        /// <summary>Redirects to the latest MSIX for "x64" or "arm64".</summary>
        public static string MsixUrl(string arch) => "https://claude.ai/api/desktop/win32/" + arch + "/msix/latest/redirect";

        static readonly Regex ReleasePath = new Regex(@"/releases/win32/(?<arch>[A-Za-z0-9_]+)/(?<ver>\d+(?:\.\d+){1,3})/[^/]+\.msix$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        static readonly Regex AnthropicName = new Regex(@"(^|,)\s*(O|CN)\s*=\s*(""Anthropic, PBC""|Anthropic, PBC)\s*(,|$)", RegexOptions.CultureInvariant);

        /// <summary>"3.6556.2" for https://downloads.claude.ai/releases/win32/x64/3.6556.2/Claude-….msix, null for other addresses.</summary>
        public static string VersionOf(Uri uri)
        {
            var m = ReleasePath.Match(uri.AbsolutePath);
            return m.Success ? m.Groups["ver"].Value : null;
        }

        /// <summary>Claude-3.6556.2-x64.msix for a release; the address's own file name, or Claude-x64.msix, for anything else.</summary>
        public static string FileNameFor(Uri uri, string arch)
        {
            var m = ReleasePath.Match(uri.AbsolutePath);
            if (m.Success) return "Claude-" + m.Groups["ver"].Value + "-" + m.Groups["arch"].Value.ToLowerInvariant() + ".msix";
            var last = Uri.UnescapeDataString(uri.Segments.LastOrDefault() ?? "");
            if (IsPackageFile(last) || last.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return last;
            return "Claude-" + arch + ".msix";
        }

        /// <summary>An MSIX/APPX package or bundle (as opposed to an installer exe).</summary>
        public static bool IsPackageFile(string path) =>
            Regex.IsMatch(path ?? "", @"\.(msix|msixbundle|appx|appxbundle)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>A certificate subject or package publisher naming Anthropic as the organization.</summary>
        public static bool IsAnthropicSubject(string subject) => subject != null && AnthropicName.IsMatch(subject);

        /// <summary>
        /// The 13-character publisher id that ends a package family name: the first 64 bits of SHA-256 over the
        /// UTF-16 publisher, plus one zero bit, in Crockford's base 32.
        /// </summary>
        public static string PublisherIdOf(string publisher)
        {
            byte[] hash;
            using (var sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.Unicode.GetBytes(publisher ?? ""));
            ulong v = 0;
            for (int i = 0; i < 8; i++) v = v << 8 | hash[i];
            const string digits = "0123456789abcdefghjkmnpqrstvwxyz";
            var sb = new StringBuilder(13);
            for (int i = 0; i < 12; i++) sb.Append(digits[(int)((v >> (59 - 5 * i)) & 31)]);
            sb.Append(digits[(int)((v & 15) << 1)]);
            return sb.ToString();
        }

        /// <summary>What an Add-AppxPackage failure means, from the HRESULT in its message; null when it is not a known one.</summary>
        public static string ExplainInstallError(string output)
        {
            var m = Regex.Match(output ?? "", @"0x8[0-9A-F]{7}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!m.Success) return null;
            switch (m.Value.ToUpperInvariant().Replace("0X", "0x"))
            {
                case "0x80073D28":
                    return "这个安装包要用管理员权限安装（里面有 Cowork 虚拟机服务）";
                case "0x80073CF6":
                case "0x80073CF9":
                    return "Windows 没能完成安装（" + m.Value + "）。先重启电脑再试；还不行就用官网的安装程序 ClaudeSetup.exe（右键“以管理员身份运行”），它会把详细原因写进 %TEMP%\\ClaudeSetup.log";
                case "0x80073D06":
                    return "电脑上已经装了更新的版本，不需要再装这个";
                case "0x80073CFB":
                    return "已经装了同一个版本，但文件不一样。先在“设置 → 应用”里卸载 Claude 再装";
                case "0x80073D02":
                    return "Claude 还在运行，没法替换它的文件。先关闭 Claude（包括托盘图标）再装";
                case "0x80073CF0":
                case "0x80070057":
                    return "安装包打不开，可能下载得不完整，请删掉重新下载";
                case "0x800B0109":
                case "0x800B010A":
                case "0x800B0101":
                    return "Windows 不信任安装包的签名证书（" + m.Value + "）。检查电脑的日期时间是否正确，并安装 Windows 更新（更新根证书）";
                case "0x80073CFF":
                case "0x80073D01":
                    return "系统策略不允许安装这个应用（" + m.Value + "）。公司电脑请联系管理员；个人电脑请在“设置 → 隐私和安全性 → 开发者选项”里允许安装来自任意来源的应用";
                case "0x80073CF3":
                    return "安装包的依赖或版本冲突检查没通过（0x80073CF3）。先卸载旧版本 Claude 再装";
                case "0x80070070":
                    return "磁盘空间不够（0x80070070）";
                case "0x80070005":
                    return "拒绝访问（0x80070005）";
            }
            return null;
        }
    }

    /// <summary>The Identity element of an MSIX package (or bundle) manifest.</summary>
    public sealed class PackageIdentity
    {
        public string Name = "";
        public string Publisher = "";
        public string Version = "";
        public string Architecture = "";
        public bool Bundle;

        /// <summary>
        /// Anthropic's Claude package. Windows installs a package only when its signature matches the publisher,
        /// and the family name it will get is Name_PublisherId.
        /// </summary>
        public bool IsClaude =>
            Regex.IsMatch(Name, @"^(Claude|Anthropic\.Claude(Desktop)?)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            && (ClaudeRelease.PublisherIdOf(Publisher) == ClaudeRelease.PublisherId || ClaudeRelease.IsAnthropicSubject(Publisher));

        public string FamilyName => Name + "_" + ClaudeRelease.PublisherIdOf(Publisher);

        /// <summary>Null, with the reason, when <paramref name="path"/> is not a readable package.</summary>
        public static PackageIdentity Read(string path, out string error)
        {
            error = null;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var zip = new ZipArchive(fs, ZipArchiveMode.Read))
                {
                    bool bundle = false;
                    var entry = zip.GetEntry("AppxManifest.xml");
                    if (entry == null)
                    {
                        entry = zip.GetEntry("AppxMetadata/AppxBundleManifest.xml");
                        bundle = entry != null;
                    }
                    if (entry == null)
                    {
                        error = "这不是 MSIX 安装包（里面没有 AppxManifest.xml）";
                        return null;
                    }
                    if (entry.Length > 4 * 1024 * 1024)
                    {
                        error = "安装包的清单大得不正常";
                        return null;
                    }
                    string xml;
                    using (var s = entry.Open())
                    using (var reader = new StreamReader(s, Encoding.UTF8, true))
                        xml = reader.ReadToEnd();
                    var m = Regex.Match(xml, @"<(?:\w+:)?Identity\s([^>]*)>");
                    if (!m.Success)
                    {
                        error = "安装包的清单里没有 Identity";
                        return null;
                    }
                    var attrs = m.Groups[1].Value;
                    return new PackageIdentity
                    {
                        Name = Attr(attrs, "Name"),
                        Publisher = Attr(attrs, "Publisher"),
                        Version = Attr(attrs, "Version"),
                        Architecture = Attr(attrs, "ProcessorArchitecture"),
                        Bundle = bundle,
                    };
                }
            }
            catch (InvalidDataException)
            {
                error = "安装包不完整或已损坏，请删掉重新下载";
                return null;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is NotSupportedException)
            {
                error = "读取安装包失败：" + e.Message;
                return null;
            }
        }

        static string Attr(string attrs, string name)
        {
            var m = Regex.Match(attrs, @"(?:^|\s)" + name + @"\s*=\s*(""([^""]*)""|'([^']*)')", RegexOptions.CultureInvariant);
            if (!m.Success) return "";
            return WebUtility.HtmlDecode(m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value);
        }

        public override string ToString() =>
            Name + " " + Version + (Architecture.Length > 0 ? "（" + Architecture + "）" : "") + "，发布者 " + Publisher;
    }

    /// <summary>A way to reach the download server.</summary>
    public sealed class DownloadRoute
    {
        public string Label = "";
        /// <summary>Null: straight to the internet.</summary>
        public ProxyEndpoint Proxy;

        public override string ToString() => Label;
    }

    /// <summary>The PowerShell the Windows side runs to check and install packages (here so the tests can look at it).</summary>
    public static class PsScripts
    {
        /// <summary>A single-quoted string; PowerShell takes the typographic single quotes for quotes too.</summary>
        public static string Quote(string s) => "'" + Regex.Replace(s ?? "", "['\u2018\u2019\u201A\u201B]", q => q.Value + q.Value) + "'";

        /// <summary>Prints STATUS, SUBJECT and MESSAGE lines.</summary>
        public static string Signature(string file) =>
            "$s = Get-AuthenticodeSignature -LiteralPath " + Quote(file) + "; 'STATUS ' + $s.Status; " +
            "if ($s.SignerCertificate) { 'SUBJECT ' + $s.SignerCertificate.Subject }; 'MESSAGE ' + $s.StatusMessage";

        /// <summary>
        /// Checks the signature once more (in the elevated process, right before installing) and installs the
        /// package. Writes OK, ERROR, SIGNATURE or SIGNER lines to <paramref name="log"/>; exit code 0, 1, 3, 4.
        /// </summary>
        public static string AddPackage(string file, string log) =>
            "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
            "$f=" + Quote(file) + ";$l=" + Quote(log) + ";" +
            "function Say($t){[IO.File]::AppendAllText($l,$t+\"`r`n\",[Text.Encoding]::UTF8)};" +
            "try{$s=Get-AuthenticodeSignature -LiteralPath $f;" +
            "if($s.Status -eq 'Valid'){if($s.SignerCertificate.Subject -notmatch '(^|,)\\s*(O|CN)\\s*=\\s*\"?Anthropic, PBC\"?\\s*(,|$)'){Say('SIGNER '+$s.SignerCertificate.Subject);exit 4}}" +
            "elseif(@('NotSigned','HashMismatch','NotTrusted') -contains [string]$s.Status){Say('SIGNATURE '+$s.Status);exit 3};" +
            "Add-AppxPackage -Path $f -ForceApplicationShutdown;Say 'OK';exit 0" +
            "}catch{Say('ERROR '+$_.Exception.Message);exit 1}";
    }
}
