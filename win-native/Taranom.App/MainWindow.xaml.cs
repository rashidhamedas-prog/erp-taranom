using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace Taranom.App;

public partial class MainWindow : Window
{
    private DomainPipeClient? _client;
    private string? _sessionId;
    private string _pipeName = "erp-taranom-domain";

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await ConnectHostAsync();
    }

    private DomainPipeClient Client => _client ??= new DomainPipeClient(_pipeName);

    private async Task ConnectHostAsync()
    {
        StatusText.Text = "اتصال به Domain Host…";
        try
        {
            var brand = await Client.InvokeAsync("brand.get");
            var ver = await Client.InvokeAsync("version");
            TitleText.Text = brand.GetProperty("productName").GetString() ?? "ERP";
            HostStatus.Text =
                $"Host {ver.GetProperty("version").GetString()} · {ver.GetProperty("phase").GetString()}";
            StatusText.Text = "آماده — وارد شوید.";
            LoginPanel.IsEnabled = true;
        }
        catch (Exception ex)
        {
            StatusText.Text = "Host در دسترس نیست. ابتدا host-main.js را اجرا کنید.\n" + ex.Message;
            LoginPanel.IsEnabled = false;
        }
    }

    private async void OnLoginClick(object sender, RoutedEventArgs e)
    {
        try
        {
            StatusText.Text = "ورود…";
            var user = UserBox.Text.Trim();
            var pass = PassBox.Password;
            var result = await Client.InvokeAsync("auth.login", new { username = user, password = pass });
            _sessionId = result.GetProperty("sessionId").GetString();
            var uname = result.GetProperty("user").GetProperty("username").GetString();
            StatusText.Text = $"ورود موفق: {uname}";
            LoginPanel.Visibility = Visibility.Collapsed;
            WorkPanel.Visibility = Visibility.Visible;
            await RefreshCustomersAsync();
            await RefreshSyncAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = "خطای ورود: " + ex.Message;
        }
    }

    private async void OnRefreshCustomers(object sender, RoutedEventArgs e) => await RefreshCustomersAsync();

    private async void OnCreateCustomer(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_sessionId)) return;
        try
        {
            var biz = NewBizBox.Text.Trim();
            if (biz.Length < 2) { StatusText.Text = "نام کسب‌وکار لازم است"; return; }
            var phone = NewPhoneBox.Text.Trim();
            var res = await Client.InvokeAsync("api.call", new
            {
                sessionId = _sessionId,
                method = "POST",
                path = "/customers",
                body = new { biz, phone, owner = "WPF" },
                idempotencyKey = "wpf-cust-" + Guid.NewGuid().ToString("N"),
            });
            var status = res.GetProperty("status").GetInt32();
            StatusText.Text = status == 200 ? "مشتری ثبت شد" : "خطا: " + status;
            await RefreshCustomersAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }

    private async void OnBackup(object sender, RoutedEventArgs e)
    {
        try
        {
            var bak = await Client.InvokeAsync("backup.local");
            StatusText.Text = "بکاپ محلی: " + bak.GetProperty("bytes").GetInt64() + " بایت";
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }

    private async void OnSyncNow(object sender, RoutedEventArgs e)
    {
        try
        {
            var r = await Client.InvokeAsync("sync.now", new { sessionId = _sessionId });
            StatusText.Text = "sync: " + r.ToString();
            await RefreshSyncAsync();
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }

    private async Task RefreshCustomersAsync()
    {
        if (string.IsNullOrEmpty(_sessionId)) return;
        var res = await Client.InvokeAsync("api.call", new
        {
            sessionId = _sessionId,
            method = "GET",
            path = "/customers",
        });
        CustomerList.Items.Clear();
        if (res.GetProperty("status").GetInt32() != 200) return;
        var body = res.GetProperty("body");
        if (body.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in body.EnumerateArray())
            {
                var biz = row.TryGetProperty("biz", out var b) ? b.GetString() : "?";
                var id = row.TryGetProperty("id", out var i) ? i.ToString() : "";
                CustomerList.Items.Add($"{id} — {biz}");
            }
        }
    }

    private async Task RefreshSyncAsync()
    {
        try
        {
            var st = await Client.InvokeAsync("sync.status");
            SyncStatus.Text = st.ToString();
        }
        catch
        {
            SyncStatus.Text = "—";
        }
    }
}
