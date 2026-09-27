using System.Windows;

namespace Taranom.App;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await RefreshHostAsync();
    }

    private async Task RefreshHostAsync()
    {
        StatusText.Text = "در حال اتصال به Domain Host…";
        try
        {
            using var client = new DomainPipeClient();
            var brand = await client.InvokeAsync("brand.get");
            var ver = await client.InvokeAsync("version");
            TitleText.Text = brand.GetProperty("productName").GetString() ?? "ERP";
            StatusText.Text =
                $"Host {ver.GetProperty("version").GetString()} · {ver.GetProperty("phase").GetString()} · pipe OK";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Host در دسترس نیست — ابتدا node win-native/DomainHost/host-main.js را اجرا کنید.\n" + ex.Message;
        }
    }
}
