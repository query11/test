using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

// Pretends to be Claude.exe: records how it was started, then behaves like a small Electron app
// (a helper copy of itself, a console child like an MCP server, and a window that closes on WM_CLOSE).
static class FakeClaude
{
    [STAThread]
    static int Main(string[] args)
    {
        var self = Process.GetCurrentProcess();
        var type = args.FirstOrDefault(a => a.StartsWith("--type=", StringComparison.Ordinal));
        var dir = Path.Combine(Path.GetTempPath(), "fakeclaude");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, self.Id + ".txt"), string.Join("\n", new[]
        {
            "cmd=" + Environment.CommandLine,
            "type=" + (type ?? "main"),
            "HTTPS_PROXY=" + Environment.GetEnvironmentVariable("HTTPS_PROXY"),
            "FOO=" + Environment.GetEnvironmentVariable("FOO"),
            "TZ=" + TimeZoneInfo.Local.Id,
        }));
        if (type != null)
        {
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
        if (args.Contains("--viewer"))
        {
            // A windowed program somewhere else that "Claude" opened, like VS Code; must survive.
            Application.Run(new Form { Text = "Viewer", Width = 240, Height = 160 });
            return 0;
        }
        Process.Start(new ProcessStartInfo(self.MainModule.FileName, "--type=renderer") { UseShellExecute = false });
        Process.Start(new ProcessStartInfo("ping.exe", "-n 600 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true });
        if (args.Contains("--spawn-gui"))
        {
            var viewer = Path.Combine(dir, "gui", "viewer.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(viewer));
            try { File.Copy(self.MainModule.FileName, viewer, true); }
            catch (IOException) { /* still running from an earlier round */ }
            Process.Start(new ProcessStartInfo(viewer, "--viewer") { UseShellExecute = false });
        }
        Application.Run(new Form { Text = "Fake Claude", Width = 320, Height = 200 });
        return 0;
    }
}
