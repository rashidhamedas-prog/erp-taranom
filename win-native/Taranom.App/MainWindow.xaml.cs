using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace Taranom.App;

public partial class MainWindow : Window
{
    private DomainPipeClient? _client;
    private string? _sessionId;
    private string _page = "customers";

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await ConnectHostAsync();
    }

    private DomainPipeClient Client => _client ??= new DomainPipeClient();

    private async Task ConnectHostAsync()
    {
        StatusText.Text = "اتصال به Domain Host…";
        try
        {
            var brand = await Client.InvokeAsync("brand.get");
            var ver = await Client.InvokeAsync("version");
            TitleText.Text = brand.GetProperty("productName").GetString() ?? "ERP Taranom";
            HostStatus.Text = $"Host {ver.GetProperty("version").GetString()} · {ver.GetProperty("phase").GetString()} · بدون WebView";
            StatusText.Text = "Host آماده است. وارد شوید یا مهاجرت را اجرا کنید.";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Host در دسترس نیست. ابتدا host-main.js را اجرا کنید.\n" + ex.Message;
        }
    }

    private async void OnReconnectClick(object sender, RoutedEventArgs e)
    {
        _client?.Dispose();
        _client = null;
        await ConnectHostAsync();
    }

    private async void OnLoginClick(object sender, RoutedEventArgs e)
    {
        try
        {
            StatusText.Text = "ورود…";
            var result = await Client.InvokeAsync("auth.login", new
            {
                username = UserBox.Text.Trim(),
                password = PassBox.Password,
            });
            _sessionId = result.GetProperty("sessionId").GetString();
            var user = result.GetProperty("user");
            UserBadge.Text = user.GetProperty("username").GetString() + " · " + user.GetProperty("role").GetString();
            LoginPanel.Visibility = Visibility.Collapsed;
            NavPanel.Visibility = Visibility.Visible;
            WorkPanel.Visibility = Visibility.Visible;
            await ShowPageAsync("customers");
        }
        catch (Exception ex)
        {
            StatusText.Text = "خطای ورود: " + ex.Message;
        }
    }

    private void OnLogout(object sender, RoutedEventArgs e)
    {
        _ = Client.InvokeAsync("auth.logout", new { sessionId = _sessionId });
        _sessionId = null;
        UserBadge.Text = "";
        NavPanel.Visibility = Visibility.Collapsed;
        WorkPanel.Visibility = Visibility.Collapsed;
        LoginPanel.Visibility = Visibility.Visible;
        StatusText.Text = "خارج شدید.";
    }

    private async void OnNavCustomers(object s, RoutedEventArgs e) => await ShowPageAsync("customers");
    private async void OnNavProducts(object s, RoutedEventArgs e) => await ShowPageAsync("products");
    private async void OnNavInvoices(object s, RoutedEventArgs e) => await ShowPageAsync("invoices");
    private async void OnNavReports(object s, RoutedEventArgs e) => await ShowPageAsync("reports");
    private async void OnNavWarehouses(object s, RoutedEventArgs e) => await ShowPageAsync("warehouses");
    private async void OnRefresh(object s, RoutedEventArgs e) => await ShowPageAsync(_page);

    private async Task ShowPageAsync(string page)
    {
        if (string.IsNullOrEmpty(_sessionId)) return;
        _page = page;
        CustomerCompose.Visibility = page == "customers" ? Visibility.Visible : Visibility.Collapsed;
        InvoiceCompose.Visibility = page == "invoices" ? Visibility.Visible : Visibility.Collapsed;
        MainList.Items.Clear();
        try
        {
            switch (page)
            {
                case "customers":
                    PageTitle.Text = "مشتریان";
                    await FillListAsync("/customers", row =>
                    {
                        var id = Prop(row, "id");
                        var biz = Prop(row, "biz");
                        var phone = Prop(row, "phone");
                        return $"{id} — {biz} — {phone}";
                    });
                    break;
                case "products":
                    PageTitle.Text = "کالاها";
                    await FillListAsync("/products", row =>
                    {
                        var id = Prop(row, "id");
                        var name = Prop(row, "name");
                        var stock = Prop(row, "stock");
                        var price = Prop(row, "price");
                        return $"{id} — {name} · موجودی {stock} · قیمت {price}";
                    });
                    break;
                case "invoices":
                    PageTitle.Text = "فاکتورها";
                    await FillListAsync("/invoices", row =>
                    {
                        var id = Prop(row, "id");
                        var num = Prop(row, "num");
                        var final = Prop(row, "final");
                        var status = Prop(row, "status");
                        return $"{id} — {num} · مبلغ {final} · {status}";
                    });
                    break;
                case "warehouses":
                    PageTitle.Text = "انبارها / موجودی";
                    await FillListAsync("/warehouses", row =>
                    {
                        var id = Prop(row, "id");
                        var name = Prop(row, "name");
                        return $"انبار {id} — {name}";
                    });
                    try
                    {
                        var stock = await Client.ApiCallAsync(_sessionId!, "GET", "/warehouses/stock/overview");
                        MainList.Items.Add("--- نمای کلی موجودی ---");
                        MainList.Items.Add(stock.GetProperty("body").ToString()[..Math.Min(500, stock.GetProperty("body").ToString().Length)]);
                    }
                    catch { /* overview optional */ }
                    break;
                case "reports":
                    PageTitle.Text = "گزارش‌ها";
                    var summary = await Client.ApiCallAsync(_sessionId!, "GET", "/reports/summary");
                    var tb = await Client.ApiCallAsync(_sessionId!, "GET", "/accounting/trial-balance");
                    MainList.Items.Add("خلاصه فروش: " + summary.GetProperty("body").ToString());
                    MainList.Items.Add("تراز آزمایشی balanced=" +
                        (tb.GetProperty("body").TryGetProperty("balanced", out var b) ? b.ToString() : "?"));
                    var sync = await Client.InvokeAsync("sync.status");
                    MainList.Items.Add("Sync: " + sync.ToString());
                    break;
            }
            StatusText.Text = $"صفحه {page} بارگذاری شد.";
        }
        catch (Exception ex)
        {
            StatusText.Text = ex.Message;
        }
    }

    private async Task FillListAsync(string path, Func<JsonElement, string> map)
    {
        var res = await Client.ApiCallAsync(_sessionId!, "GET", path);
        if (res.GetProperty("status").GetInt32() != 200)
        {
            MainList.Items.Add("خطا status=" + res.GetProperty("status"));
            return;
        }
        var body = res.GetProperty("body");
        if (body.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in body.EnumerateArray())
                MainList.Items.Add(map(row));
        }
        else if (body.TryGetProperty("rows", out var rows) && rows.ValueKind == JsonValueKind.Array)
        {
            foreach (var row in rows.EnumerateArray())
                MainList.Items.Add(map(row));
        }
        else
        {
            MainList.Items.Add(body.ToString());
        }
    }

    private static string Prop(JsonElement row, string name)
        => row.TryGetProperty(name, out var v) ? v.ToString() : "";

    private async void OnCreateCustomer(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_sessionId)) return;
        try
        {
            var biz = NewBizBox.Text.Trim();
            if (biz.Length < 2) { StatusText.Text = "نام کسب‌وکار لازم است"; return; }
            await Client.ApiCallAsync(_sessionId, "POST", "/customers",
                new { biz, phone = NewPhoneBox.Text.Trim(), owner = "WPF" },
                "wpf-cust-" + Guid.NewGuid().ToString("N"));
            NewBizBox.Text = "";
            NewPhoneBox.Text = "";
            StatusText.Text = "مشتری ثبت شد";
            await ShowPageAsync("customers");
        }
        catch (Exception ex) { StatusText.Text = ex.Message; }
    }

    private async void OnCreateInvoice(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_sessionId)) return;
        try
        {
            if (!int.TryParse(InvCustIdBox.Text.Trim(), out var custId) || custId <= 0)
            { StatusText.Text = "شناسه مشتری نامعتبر"; return; }
            if (!int.TryParse(InvProductIdBox.Text.Trim(), out var productId) || productId <= 0)
            { StatusText.Text = "شناسه کالا نامعتبر"; return; }
            var qty = int.TryParse(InvQtyBox.Text.Trim(), out var q) ? Math.Max(1, q) : 1;
            var price = long.TryParse(InvPriceBox.Text.Trim().Replace(",", ""), out var p) ? p : 0L;
            var body = new
            {
                custId,
                type = "proforma",
                date = DateTime.Now.ToString("yyyy/MM/dd"),
                rows = new[] { new { productId, qty, price, name = "WPF line" } },
            };
            var res = await Client.ApiCallAsync(_sessionId, "POST", "/invoices", body,
                "wpf-inv-" + Guid.NewGuid().ToString("N"));
            StatusText.Text = "پیش‌فاکتور: status=" + res.GetProperty("status") + " · " + res.GetProperty("body").ToString()[..Math.Min(180, res.GetProperty("body").ToString().Length)];
            await ShowPageAsync("invoices");
        }
        catch (Exception ex) { StatusText.Text = ex.Message; }
    }

    private async void OnBackup(object sender, RoutedEventArgs e)
    {
        try
        {
            var bak = await Client.InvokeAsync("backup.local");
            StatusText.Text = "بکاپ: " + bak.GetProperty("bytes").GetInt64().ToString("N0") + " بایت → " + bak.GetProperty("dest").GetString();
        }
        catch (Exception ex) { StatusText.Text = ex.Message; }
    }

    private async void OnSyncNow(object sender, RoutedEventArgs e)
    {
        try
        {
            var r = await Client.InvokeAsync("sync.now", new { sessionId = _sessionId });
            StatusText.Text = "Sync: " + r.ToString();
        }
        catch (Exception ex) { StatusText.Text = ex.Message; }
    }

    private void OnMigrationClick(object sender, RoutedEventArgs e)
    {
        var preview = MigrationWizard.Preview();
        var ask = MessageBox.Show(
            preview.Message + "\n\nآیا مهاجرت کپی شود؟ (Host را بعداً با ERP_HOST_DATA روی مقصد اجرا کنید)",
            "مهاجرت از Electron",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question);
        if (ask != MessageBoxResult.Yes) return;
        var result = MigrationWizard.Run(overwrite: false);
        if (!result.Ok && result.Message.Contains("از قبل"))
        {
            var overwrite = MessageBox.Show("مقصد پر است. بازنویسی؟", "مهاجرت", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (overwrite == MessageBoxResult.Yes)
                result = MigrationWizard.Run(overwrite: true);
        }
        StatusText.Text = result.Message;
        MessageBox.Show(result.Message, result.Ok ? "موفق" : "ناموفق");
    }
}
