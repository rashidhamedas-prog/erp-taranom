# کلید SSH سرور ایران

کلید **خصوصی** هرگز داخل مخزن نیست. فقط کلید عمومی اینجا ثبت می‌شود تا معلوم باشد کدام هویت به `taranom@94.249.244.208` وصل می‌شود.

## محل‌های مجاز کلید خصوصی

1. **GitHub Actions Secret** (روش اصولی روی ریپو): `IRAN_SSH_PRIVATE_KEY`
2. ماشین توسعه: `D:\proje\.ssh\id_ed25519_taranom` یا `%USERPROFILE%\.ssh\id_ed25519_taranom`
3. متغیر محیطی: `IRAN_SSH_KEY` = مسیر فایل خصوصی

## ثبت Secret

```powershell
gh secret set IRAN_SSH_PRIVATE_KEY --repo rashidhamedas-prog/erp-taranom --body-file D:\proje\.ssh\id_ed25519_taranom
```

در UI: Settings → Secrets and variables → Actions → `IRAN_SSH_PRIVATE_KEY`

## اتصال محلی

```powershell
ssh -i D:\proje\.ssh\id_ed25519_taranom taranom@94.249.244.208
# یا بعد از کپی به ~/.ssh :
ssh taranom-ir
```
