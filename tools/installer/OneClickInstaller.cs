using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static class OneClickInstaller
{
    private const string ResourceName = "FeishuCodexBridgePayload";

    private static int Main()
    {
        string target = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "FeishuCodexBridge"
        );
        string temp = Path.Combine(Path.GetTempPath(), "FeishuCodexBridge-" + Guid.NewGuid().ToString("N"));
        string zipPath = Path.Combine(temp, "payload.zip");
        string extractPath = Path.Combine(temp, "payload");

        try
        {
            Directory.CreateDirectory(temp);
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
            {
                if (input == null)
                {
                    Console.Error.WriteLine("Payload resource was not found.");
                    return 2;
                }

                using (FileStream output = File.Create(zipPath))
                {
                    input.CopyTo(output);
                }
            }

            if (Directory.Exists(extractPath))
            {
                Directory.Delete(extractPath, true);
            }
            ZipFile.ExtractToDirectory(zipPath, extractPath);
            Directory.CreateDirectory(target);
            CopyDirectory(extractPath, target);
            CreateDesktopShortcut(target);
            CreateStartupTask(target);
            CreateHealthCheckTask(target);

            string app = Path.Combine(target, "FeishuCodexBridge.exe");
            Process.Start(new ProcessStartInfo
            {
                FileName = app,
                WorkingDirectory = target,
                UseShellExecute = true
            });
            Process.Start("http://127.0.0.1:3457/settings");

            Console.WriteLine("Installed to: " + target);
            Console.WriteLine("Admin page: http://127.0.0.1:3457/settings");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
        finally
        {
            try
            {
                if (Directory.Exists(temp))
                {
                    Directory.Delete(temp, true);
                }
            }
            catch
            {
            }
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        foreach (string directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            string relative = directory.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            Directory.CreateDirectory(Path.Combine(target, relative));
        }

        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            string relative = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string destination = Path.Combine(target, relative);
            string destinationDirectory = Path.GetDirectoryName(destination);
            if (!string.IsNullOrEmpty(destinationDirectory))
            {
                Directory.CreateDirectory(destinationDirectory);
            }
            File.Copy(file, destination, true);
        }
    }

    private static void CreateDesktopShortcut(string target)
    {
        try
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string shortcutPath = Path.Combine(desktop, "FeishuCodexBridge.lnk");
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath }
            );
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(target, "FeishuCodexBridge.exe") });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Feishu Codex Bridge" });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch
        {
        }
    }

    private static void CreateStartupTask(string target)
    {
        string script = Path.Combine(target, "scripts", "start-hidden.vbs");
        if (!File.Exists(script)) return;

        string taskCommand = "wscript.exe " + QuoteForTask(script);
        RunSchtasks("/Create /TN \"FeishuCodexBridgeStartup\" /SC ONLOGON /TR \"" + taskCommand + "\" /F");
    }

    private static void CreateHealthCheckTask(string target)
    {
        string script = Path.Combine(target, "scripts", "health-check-hidden.vbs");
        if (!File.Exists(script)) return;

        string taskCommand = "wscript.exe " + QuoteForTask(script);
        RunSchtasks("/Create /TN \"FeishuCodexBridgeHealthCheck\" /SC MINUTE /MO 5 /TR \"" + taskCommand + "\" /F");
    }

    private static string QuoteForTask(string path)
    {
        return "\\\"" + path + "\\\"";
    }

    private static void RunSchtasks(string arguments)
    {
        try
        {
            Process process = Process.Start(new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            });
            if (process != null)
            {
                process.WaitForExit(10000);
            }
        }
        catch
        {
        }
    }
}
