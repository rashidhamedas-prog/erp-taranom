using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Taranom.App;

public sealed class DomainPipeClient : IDisposable
{
    private readonly string _pipeName;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public DomainPipeClient(string? pipeName = null)
    {
        _pipeName = pipeName ?? Environment.GetEnvironmentVariable("ERP_HOST_PIPE_NAME") ?? "erp-taranom-domain";
    }

    public async Task<JsonElement> InvokeAsync(string command, object? payload = null, CancellationToken ct = default)
    {
        await using var pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(8000, ct);

        var id = Guid.NewGuid().ToString("N");
        var req = JsonSerializer.Serialize(new { id, command, payload = payload ?? new { } }, JsonOpts);
        var bytes = Encoding.UTF8.GetBytes(req + "\n");
        await pipe.WriteAsync(bytes, ct);
        await pipe.FlushAsync(ct);

        using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var line = await reader.ReadLineAsync(ct)
            ?? throw new InvalidOperationException("پاسخ خالی از Domain Host");
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement.Clone();
        if (!root.GetProperty("ok").GetBoolean())
        {
            var msg = root.TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m)
                ? m.GetString()
                : "خطای Host";
            throw new InvalidOperationException(msg);
        }
        return root.GetProperty("result").Clone();
    }

    public Task<JsonElement> ApiCallAsync(string sessionId, string method, string path, object? body = null, string? idempotencyKey = null, CancellationToken ct = default)
        => InvokeAsync("api.call", new
        {
            sessionId,
            method,
            path,
            body,
            idempotencyKey,
        }, ct);

    public void Dispose() { }
}
