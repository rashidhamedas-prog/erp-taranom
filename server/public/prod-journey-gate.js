/**
 * prod-journey-gate.js — دروازهٔ ترتیبی مسیر ۶مرحله‌ای داشبورد تولید
 * UMD: window.ProdJourneyGate در مرورگر؛ module.exports در Node (تست).
 * قانون: ورود به مرحلهٔ N فقط وقتی مراحل ۱…N−۱ همگی done باشند.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ProdJourneyGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STEP_DEFS = [
    {
      key: 'bom',
      n: '۱',
      title: 'فرمول ساخت',
      desc: 'مواد، مسیر و نرخ دستمزد',
      cta: 'باز کردن BOM',
      go: 'acc-production-boms',
      path: 'both',
      how: 'حداقل یک فرمول ساخت (BOM) با وضعیت «فعال» لازم است.',
    },
    {
      key: 'order',
      n: '۲',
      title: 'سفارش تولید',
      desc: 'برنامه، آزادسازی، مراحل',
      cta: 'سفارش‌ها',
      go: 'acc-production-orders',
      path: 'order',
      how: 'حداقل یک سفارش تولید آزادشده (غیر پیش‌نویس/لغو) لازم است — ثبت پیش‌نویس کافی نیست.',
    },
    {
      key: 'lay',
      n: '۳',
      title: 'لایه‌چینی',
      desc: 'مصرف طاقه → WIP',
      cta: 'ثبت لایه‌چینی',
      goFn: 'goCuttingLaysView',
      goArg: 'lays',
      path: 'cut',
      how: 'حداقل یک لایه‌چینی ثبت‌شده (غیر ابطال‌شده) لازم است.',
    },
    {
      key: 'kanban',
      n: '۴',
      title: 'مراحل BOM / تابلوی خط',
      desc: 'تکمیل مرحله‌به‌مرحله با حواله و سند',
      cta: 'کانبان',
      go: 'acc-production-kanban',
      path: 'order',
      how: 'برای سفارش چندمرحله‌ای حداقل یک مرحلهٔ مسیر BOM باید «انجام شد» باشد (آزادسازی به‌تنهایی کافی نیست). مسیر بدون مسیر عملیات این مرحله را خودکار تکمیل می‌کند.',
    },
    {
      key: 'pack',
      n: '۵',
      title: 'PACK / رسید محصول',
      desc: 'با سفارش: بسته‌بندی WIP؛ فروش‌پذیر با finalize',
      cta: 'بسته‌بندی / رسید',
      goFn: 'goCuttingLaysView',
      goArg: 'pending-pack',
      path: 'cut',
      how: 'پس از لایه‌چینی PACK بزنید. با سفارش باز، موجودی فروش‌پذیر فقط در نهایی‌سازی وارد انبار محصول می‌شود.',
    },
    {
      key: 'cost',
      n: '۶',
      title: 'بهای تمام‌شده',
      desc: 'برگه بها و سود',
      cta: 'برگه بها',
      go: 'acc-production-cost-sheet',
      path: 'both',
      how: 'بهای واحد حداقل یک سفارش باید محاسبه شده باشد؛ برای سفارش پارچهٔ متری لایه‌چینی (و PACK) هم لازم است تا برگه «نهایی» شود — بدون لایه فقط بهای موقت است.',
    },
  ];

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * @param {object} m metrics from dashboard fetch
   * @returns {object[]} steps with done + howFilled
   */
  function buildSteps(m) {
    const activeBoms = num(m.activeBoms);
    const releasedOrders = num(m.releasedOrders);
    const hasLay = !!m.hasLay;
    const hasAdvStages = !!m.hasAdvStages;
    // v409: فقط تکمیل واقعی مرحله (done) — نه in_progress ناشی از آزادسازی
    const stagesProgressed = !!(m.stagesProgressed != null ? m.stagesProgressed : m.kanbanTouched);
    const postedPacks = num(m.postedPacks);
    const pendingPack = num(m.pendingPack);
    const hasUnitCost = !!m.hasUnitCost;

    const doneFlags = [
      activeBoms > 0,
      releasedOrders > 0,
      hasLay,
      !hasAdvStages || stagesProgressed,
      postedPacks > 0 && pendingPack === 0,
      hasUnitCost,
    ];

    return STEP_DEFS.map((def, i) => {
      const step = Object.assign({}, def, { done: !!doneFlags[i], index: i });
      if (i === 3) {
        step.desc = hasAdvStages
          ? 'حواله/خروجی/سند هر مرحله BOM'
          : 'مخصوص سفارش چندمرحله‌ای — در مسیر ساده خودکار تکمیل';
        if (!hasAdvStages && step.done) {
          step.how = 'سفارش چندمرحله‌ای فعال نیست؛ این مرحله برای مسیر ساده خودکار تکمیل شده است.';
        } else if (hasAdvStages && !step.done) {
          step.how =
            'حداقل یک مرحله از مسیر BOM باید «انجام شد» شود (حواله مواد + خروجی + سند حسابداری). آزادسازی سفارش که مرحله را «در جریان» می‌کند کافی نیست.';
        }
      }
      if (i === 4) {
        step.cta = pendingPack > 0 ? 'PACK معلق' : def.cta;
        if (pendingPack > 0 && !step.done) {
          step.how =
            pendingPack +
            ' لایه منتظر PACK است — بسته‌بندی WIP (با سفارش) یا رسید مستقیم (بدون سفارش) را ثبت کنید؛ با سفارش، ورود فروش‌پذیر فقط در نهایی‌سازی است.';
        } else if (postedPacks === 0 && !step.done) {
          step.how = 'هنوز هیچ PACK ثبت نشده — پس از لایه‌چینی، بسته‌بندی/رسید را بزنید.';
        }
      }
      if (i === 0 && !step.done) {
        step.how = 'هیچ فرمول ساخت فعالی نیست — در «فرمول تولید» پیش‌نویس بسازید و فعال کنید.';
      }
      if (i === 1 && !step.done) {
        step.how =
          activeBoms > 0
            ? 'سفارش تولید آزادشده ندارید — سفارش بسازید و آزاد کنید (پیش‌نویس کافی نیست).'
            : 'اول فرمول فعال، بعد سفارش تولید آزادشده.';
      }
      if (i === 2 && !step.done) {
        step.how =
          'لایه‌چینی ثبت نشده — از طاقهٔ انبار مواد، لایه‌چینی جدید ثبت کنید (وضعیت ابطال‌شده شمرده نمی‌شود).';
      }
      if (i === 5 && !step.done) {
        step.how =
          'بهای واحد هنوز صفر است — سفارش را تا رسید/بهایابی جلو ببرید. اگر پارچهٔ متری دارید اول لایه‌چینی و ضایعات برش را ثبت کنید؛ برگه بدون لایه فقط موقت است.';
      }
      return step;
    });
  }

  /** اولین مرحلهٔ ناتمام؛ -1 اگر همه کامل */
  function nextIndex(steps) {
    const idx = (steps || []).findIndex((s) => !s.done);
    return idx;
  }

  /**
   * ورود به مرحلهٔ targetIdx فقط اگر همهٔ قبلی‌ها done باشند.
   * مراحل انجام‌شده قابل بازگشت‌اند؛ مرحلهٔ جاری (اولین ناتمام) هم باز است.
   */
  function canEnter(steps, targetIdx) {
    const list = steps || [];
    const idx = Number(targetIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
      return { ok: false, blockers: [{ title: 'مرحله نامعتبر', how: 'شماره مرحله خارج از مسیر ۱ تا ۶ است.' }] };
    }
    if (list[idx].done) return { ok: true, blockers: [] };
    const blockers = [];
    for (let i = 0; i < idx; i++) {
      if (!list[i].done) {
        blockers.push({
          index: i,
          n: list[i].n,
          key: list[i].key,
          title: list[i].title,
          how: list[i].how,
        });
      }
    }
    return { ok: blockers.length === 0, blockers };
  }

  /** پیام فارسی دقیق برای بلاک ناوبری */
  function blockMessage(steps, targetIdx) {
    const list = steps || [];
    const target = list[targetIdx];
    const gate = canEnter(list, targetIdx);
    if (gate.ok) return '';
    const targetTitle = (target && target.title) || 'مرحله بعد';
    const lines = gate.blockers.map((b, i) => (i + 1) + ') مرحله ' + b.n + ' «' + b.title + '»: ' + b.how);
    const first = gate.blockers[0];
    const head =
      'ورود به «' +
      targetTitle +
      '» مجاز نیست — مسیر تولید باید پیوسته ۱→۶ طی شود. ' +
      (first
        ? 'اولین پیش‌نیاز ناقص: مرحله ' + first.n + ' «' + first.title + '».'
        : '');
    return head + (lines.length ? ' جزئیات:\n' + lines.join('\n') : '');
  }

  /** نگاشت مسیر SPA / view به ایندکس مرحله */
  function stepIndexForTarget(target) {
    if (!target) return -1;
    if (target === 'acc-production-boms' || target === 'bom') return 0;
    if (target === 'acc-production-orders' || target === 'order') return 1;
    if (target === 'lays' || target === 'acc-cutting-lays' || target === 'lay') return 2;
    if (target === 'acc-production-kanban' || target === 'kanban') return 3;
    if (target === 'pending-pack' || target === 'pack') return 4;
    if (target === 'acc-production-cost-sheet' || target === 'cost') return 5;
    return -1;
  }

  return {
    STEP_DEFS,
    buildSteps,
    nextIndex,
    canEnter,
    blockMessage,
    stepIndexForTarget,
  };
});
