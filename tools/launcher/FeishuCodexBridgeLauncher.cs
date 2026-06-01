using System;
using System.Diagnostics;
using System.IO;

internal static class FeishuCodexBridgeLauncher
{
    private static Process childProcess;

    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string node = FirstExisting(
            Path.Combine(root, "codex-bin", "node.exe"),
            Path.Combine(root, "runtime", "node.exe"),
            "node.exe"
        );
        string tsx = Path.Combine(root, "node_modules", "tsx", "dist", "cli.mjs");
        string server = Path.Combine(root, "src", "server.ts");

        if (!File.Exists(tsx))
        {
            Console.Error.WriteLine("Missing tsx runtime: " + tsx);
            return 2;
        }

        if (!File.Exists(server))
        {
            Console.Error.WriteLine("Missing server entry: " + server);
            return 2;
        }

        AppDomain.CurrentDomain.ProcessExit += delegate { StopChild(); };
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
        {
            eventArgs.Cancel = true;
            StopChild();
        };

        string arguments = Quote(tsx) + " " + Quote(server);
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = node,
            Arguments = arguments,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = false
        };

        string portableCodex = Path.Combine(root, "codex-bin", "codex.exe");
        if (File.Exists(portableCodex))
        {
            string path = startInfo.EnvironmentVariables["PATH"] ?? "";
            startInfo.EnvironmentVariables["PATH"] = Path.Combine(root, "codex-bin") + Path.PathSeparator + path;
        }

        Console.WriteLine("Feishu Codex Bridge");
        Console.WriteLine("Root: " + root);
        Console.WriteLine("Node: " + node);
        Console.WriteLine("Entry: " + server);

        try
        {
            childProcess = Process.Start(startInfo);
            childProcess.WaitForExit();
            return childProcess.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static string FirstExisting(params string[] candidates)
    {
        foreach (string candidate in candidates)
        {
            if (candidate.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        return candidates[candidates.Length - 1];
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void StopChild()
    {
        try
        {
            if (childProcess != null && !childProcess.HasExited)
            {
                childProcess.Kill();
                childProcess.WaitForExit(5000);
            }
        }
        catch
        {
        }
    }
}
