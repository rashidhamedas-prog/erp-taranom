using System.IO;
using System.Text.Json;

namespace Taranom.App;

/// <summary>
/// Copies legacy Electron desktop data into native Host data root.
/// Source: %APPDATA%\erp-taranom-desktop
/// Target: %ProgramData%\Taranom\ERP (or Brand Pack path)
/// </summary>
public static class MigrationWizard
{
    public static string DefaultElectronDataDir()
        => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "erp-taranom-desktop");

    public static string DefaultNativeDataDir(string brandProgramData = "Taranom\\ERP")
        => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), brandProgramData);

    public sealed record Result(bool Ok, string Message, string? DestDb = null, long Bytes = 0);

    public static Result Preview(string? source = null, string? destRoot = null)
    {
        source ??= DefaultElectronDataDir();
        destRoot ??= DefaultNativeDataDir();
        var db = FindDb(source);
        if (db == null)
            return new Result(false, $"دیتابیس Electron در {source} پیدا نشد.");
        var bytes = new FileInfo(db).Length;
        return new Result(true, $"منبع: {db} ({bytes:N0} بایت) → {destRoot}", db, bytes);
    }

    public static Result Run(string? source = null, string? destRoot = null, bool overwrite = false)
    {
        source ??= DefaultElectronDataDir();
        destRoot ??= DefaultNativeDataDir();
        var db = FindDb(source);
        if (db == null)
            return new Result(false, $"دیتابیس Electron در {source} پیدا نشد.");

        Directory.CreateDirectory(destRoot);
        var destDb = Path.Combine(destRoot, "erp.db");
        if (File.Exists(destDb) && !overwrite)
            return new Result(false, $"مقصد از قبل دیتابیس دارد: {destDb}. برای بازنویسی overwrite=true بزنید.");

        File.Copy(db, destDb, overwrite: true);
        foreach (var ext in new[] { "-wal", "-shm" })
        {
            var side = db + ext;
            if (File.Exists(side))
                File.Copy(side, destDb + ext, overwrite: true);
        }

        var uploadsSrc = Path.Combine(source, "uploads");
        var uploadsDst = Path.Combine(destRoot, "uploads");
        if (Directory.Exists(uploadsSrc))
            CopyDir(uploadsSrc, uploadsDst);

        var meta = new
        {
            migratedAt = DateTime.UtcNow.ToString("o"),
            source = db,
            dest = destDb,
            bytes = new FileInfo(destDb).Length,
            note = "Electron → native Host data migration",
        };
        File.WriteAllText(
            Path.Combine(destRoot, "migration.json"),
            JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true }));

        return new Result(true, "مهاجرت با موفقیت انجام شد. Host را با ERP_HOST_DATA روی همین مسیر اجرا کنید.", destDb, new FileInfo(destDb).Length);
    }

    static string? FindDb(string root)
    {
        var candidates = new[]
        {
            Path.Combine(root, "crm.db"),
            Path.Combine(root, "erp.db"),
            Path.Combine(root, "data", "crm.db"),
        };
        foreach (var c in candidates)
            if (File.Exists(c)) return c;
        if (!Directory.Exists(root)) return null;
        return Directory.EnumerateFiles(root, "*.db", SearchOption.AllDirectories)
            .OrderByDescending(f => new FileInfo(f).Length)
            .FirstOrDefault();
    }

    static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(src, file);
            var target = Path.Combine(dst, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }
}
