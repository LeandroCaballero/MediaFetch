// Bajalo.exe: abre Bajalo sin consola. Corre bin\node.exe app\server.js, que levanta el
// servidor en segundo plano si no está corriendo y abre la ventana. Si falla, muestra el error.
// Lo compila tools/build.js con el csc.exe que trae Windows (.NET Framework 4), sin instalar nada.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, @"bin\node.exe");
        string server = Path.Combine(root, @"app\server.js");
        if (!File.Exists(node) || !File.Exists(server))
        {
            return Fail("Faltan archivos en " + root + "\n\nVolvé a descomprimir el ZIP de Bajalo completo y abrí Bajalo.exe desde esa carpeta.");
        }

        var errors = new StringBuilder();
        var process = new Process();
        process.StartInfo = new ProcessStartInfo(node, "\"" + server + "\"")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            StandardErrorEncoding = Encoding.UTF8,
        };
        process.ErrorDataReceived += (sender, e) => { if (e.Data != null) lock (errors) errors.AppendLine(e.Data); };
        try
        {
            process.Start();
        }
        catch (Exception e)
        {
            return Fail("No se pudo abrir Bajalo: " + e.Message);
        }
        process.BeginErrorReadLine();
        // Con plazo: WaitForExit() a secas espera además a que se cierre stderr, y el servidor que
        // queda en segundo plano puede heredarlo abierto.
        process.WaitForExit(int.MaxValue);
        if (process.ExitCode == 0) return 0;
        Thread.Sleep(200); // que termine de llegar lo último que escribió en stderr
        string message;
        lock (errors) message = errors.ToString().Trim();
        return Fail(message.Length > 0 ? message : "Bajalo se cerró con el código " + process.ExitCode + ".");
    }

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    static int Fail(string message)
    {
        SetProcessDPIAware(); // sin esto, el cartel se ve borroso en pantallas con escala
        Application.EnableVisualStyles();
        MessageBox.Show(message, "Bajalo", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
