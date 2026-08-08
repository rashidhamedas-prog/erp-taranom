# Task فعال

## شناسه
W0-OPS-001

## عنوان
بستن عملیات P0-C و انتشار امن باینری موج صفر

## هدف
کپی واقعی بکاپ رمز‌شده خارج VPS، drill بازیابی، و انتشار verify-before-promote باینری‌های امضاشده.

## محدوده مجاز
- اسکریپت‌های pull/install/drill/provision و uploader
- تست‌ها و مستندات Gate موج صفر
- عملیات VPS فقط برای بکاپ و feed نسخه 2.0.33/2.0.10

## خارج از محدوده
- build مجدد APK/EXE
- restore مخرب production
- شروع موج ۱ تا ۴

## معیارهای پذیرش
- pull و restore واقعی با hash/fingerprint معتبر
- confinement منفی secret/DB/upload/delete
- انتشار اتمیک و HTTP hash باینری‌ها
- تست‌های مرتبط و drift صفر

## ریسک‌ها
- کلید admin انتشار هنوز broad است؛ استفاده دستی و محدود به این RC، با hardening بعدی release-publisher.
- task فعلی هنگام logout اجرا نمی‌شود تا نصب Administrator/S4U انجام شود.

## وضعیت
Completed and pushed; remote Wave 0 Gate 7/7 green
