# CRM-PRO-ANALYTICS — مدل، KPI و RBAC

واحد مالی همه APIها **ریال** است (`*_rial`). پیش‌فاکتور فروش قطعی نیست. `normal|final` فروش قطعی است. اسناد `reversed` / `deleted_at` حذف می‌شوند.

## جداول (additive)

- `crm_opportunities` — یک فرصت فعال به‌ازای مسیر فروش مشتری
- `crm_activities` — فعالیت‌ها؛ `followup_id` به پیگیری روزانه وصل است
- `crm_stage_history` — تاریخچه تغییر مرحله (تکراری برای همان مرحله ثبت نمی‌شود)
- `crm_lead_sources`, `crm_campaigns`, `crm_customer_segments`, `crm_segment_history`, `crm_files`
- `crm_automation_log` — فقط مرکز (سینک نمی‌شود)
- `followups.opportunity_id` / `followups.party_id` و `customers.lead_source` / `campaign` ستونی

Migration `crm_pro_analytics_v1` از پیگیری‌ها/فاکتورهای قبلی فرصت می‌سازد. مهر فقط جلوی مهاجرت کامل تکراری را می‌گیرد؛ مشتریانی که هنوز فرصت ندارند در اجراهای بعدی backfill می‌شوند (بدون فرصت تکراری).

## KPI (فرمول)

| کلید | فرمول |
|------|--------|
| new_leads | فرصت‌های `pipeline_stage=lead` |
| open_opportunities | `status=open` |
| pipeline_value_rial | جمع `estimated_amount_rial` فرصت باز |
| pipeline_weighted_rial | جمع `weighted_amount_rial` = مبلغ × احتمال/۱۰۰ |
| won_opportunities | stage در `first_order\|won\|repeat` |
| lost_opportunities | stage=`lost` |
| win_rate | won/(won+lost)؛ مخرج صفر → null |
| lead_to_proforma_rate | تعداد پیش‌فاکتور / سرنخ |
| proforma_to_firm_rate | فاکتور قطعی / پیش‌فاکتور |
| lead_to_firm_rate | فاکتور قطعی / سرنخ |
| firm_sales_rial / firm_invoice_count | فاکتور `normal\|final` غیر reversed |
| avg_order_rial | مبلغ قطعی / تعداد |
| new_customers | مشتری ایجادشده در بازه (created_at جلالی) |
| repeat_customers | بیش از یک فاکتور قطعی در بازه |
| open/due_today/overdue_followups | `followups.status` (نه stage) |
| stale_opportunities | فرصت باز با توقف بیش از آستانه تنظیمات |
| inactive_customers_90d | بدون فاکتور قطعی و پیگیری در ۹۰ روز |
| churn_risk_customers | `effective_segment=churn_risk` |
| receivables_rial | جمع دفتر مشتری |
| overdue_receivables_rial | مانده مثبت مشتری با فاکتور قطعی قدیمی‌تر از آستانه |
| cheques_due / cheques_bounced | lifecycle چک، با scope کارشناس |
| sales_target_percent | فروش قطعی / هدف ماهانه کاربر |

آستانه‌های سگمنت در `settings` با کلید `crm_seg_*` هستند.

## RBAC

- همه `/api/crm/*` نیاز به `followups.view`
- mutation فرصت/فعالیت: `followups.edit`
- export: `followups.export`
- `crmScopeUserId`: admin / accounting / sales_manager = تجمیعی؛ بقیه = `req.user.id`
- `user_id` کلاینت برای کاربر scoped نادیده گرفته می‌شود (حتی `0`)
- GET آنالیتیکس فقط خواندنی است؛ سگمنت‌بندی با `POST /segmentation/run` (edit + نقش مدیر)
- اتوماسیون فقط مرکز (`centralOnlyStrict`) + `followups.edit`
- فیلتر بازه: فاکتور روی `i.date`؛ فرصت روی `created_at` یونیکس همان روز جلالی؛ استان/شهر/سگمنت از مشتری
