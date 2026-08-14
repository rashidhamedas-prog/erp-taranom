/* Interactive sales-demo chrome. Production is unchanged unless /api/demo/status says demo:true. */
(function () {
  'use strict';

  function isHttpsUrl(raw) {
    try {
      var u = new URL(String(raw || '').trim());
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch (e) {
      return false;
    }
  }

  function hideLoginHints() {
    document.querySelectorAll('.login-hint').forEach(function (n) {
      n.hidden = true;
      n.setAttribute('aria-hidden', 'true');
      n.style.display = 'none';
    });
  }

  function formatExpiry(iso) {
    if (!iso) return '';
    var d = String(iso).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
    return 'اعتبار تا ' + d;
  }

  function applyDemoShell(data) {
    document.body.classList.add('erp-demo-mode');
    hideLoginHints();

    var brand = data.brand && typeof data.brand === 'object' ? data.brand : {};
    var wm = brand.demo_watermark || data.watermark || data.message || 'نسخه نمایشی — داده‌ها واقعی نیستند';

    if (!document.querySelector('.erp-demo-badge')) {
      var badge = document.createElement('div');
      badge.className = 'erp-demo-badge';
      badge.setAttribute('role', 'status');

      var t1 = document.createElement('strong');
      t1.textContent = 'نسخه نمایشی';
      badge.appendChild(t1);

      var t2 = document.createElement('span');
      t2.textContent = 'داده‌ها واقعی نیستند';
      badge.appendChild(t2);

      var exp = formatExpiry(data.expires_at);
      if (exp) {
        var t3 = document.createElement('span');
        t3.className = 'erp-demo-expiry';
        t3.textContent = exp;
        badge.appendChild(t3);
      }

      var sales = brand.sales_url || data.sales_url;
      if (isHttpsUrl(sales)) {
        var a = document.createElement('a');
        a.className = 'erp-demo-cta';
        a.href = new URL(String(sales).trim()).toString();
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'تماس با فروش';
        badge.appendChild(a);
      }

      document.body.appendChild(badge);
    }

    if (!document.querySelector('.erp-demo-watermark')) {
      var mark = document.createElement('div');
      mark.className = 'erp-demo-watermark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = String(wm);
      document.body.appendChild(mark);
    }
  }

  function start() {
    fetch('/api/demo/status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || data.demo !== true) return;
        applyDemoShell(data);
      })
      .catch(function () { /* production unchanged */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
