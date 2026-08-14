/**
 * CRM Pro schema — additive, idempotent. Does not rewrite financial rows.
 */
const STAMP = 'crm_pro_analytics_v1';

const DEFAULT_SETTINGS = {
  crm_seg_vip_monthly_rial: '200000000',
  crm_seg_vip_min_streak: '3',
  crm_seg_vip_max_cycle_days: '45',
  crm_seg_a_monthly_rial: '80000000',
  crm_seg_a_max_cycle_days: '60',
  crm_seg_b_monthly_rial: '20000000',
  crm_seg_b_max_cycle_days: '90',
  crm_seg_inactive_days: '180',
  crm_seg_churn_delay_factor: '1.5',
  crm_stale_opportunity_days: '14',
  crm_cheque_due_days: '14',
  crm_overdue_receivable_days: '30',
  crm_auto_followup_after_invoice: '1',
  crm_auto_alert_overdue: '1',
  crm_auto_alert_stale_opp: '1',
  crm_auto_alert_churn: '1',
  crm_auto_alert_cheque: '1',
  crm_auto_alert_receivable: '1',
  crm_auto_suggest_segment: '1',
};

const STAGE_MAP = {
  lead: 'lead',
  contact: 'qualified',
  qualified: 'qualified',
  proposal: 'proposal',
  negotiation: 'negotiation',
  first_order: 'first_order',
  won: 'won',
  repeat: 'repeat',
  lost: 'lost',
};

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

function ensureColumn(db, table, col, def) {
  if (!tableExists(db, table) || hasColumn(db, table, col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function normalizeStage(raw) {
  const s = String(raw || 'lead').trim().toLowerCase();
  return STAGE_MAP[s] || 'lead';
}

function initCrmProSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cost_rial INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER NOT NULL,
      owner_user_id INTEGER,
      title TEXT DEFAULT '',
      pipeline_stage TEXT NOT NULL DEFAULT 'lead',
      status TEXT NOT NULL DEFAULT 'open',
      estimated_amount_rial INTEGER NOT NULL DEFAULT 0,
      probability_percent INTEGER NOT NULL DEFAULT 10,
      weighted_amount_rial INTEGER NOT NULL DEFAULT 0,
      expected_close_date TEXT DEFAULT '',
      lead_source TEXT DEFAULT '',
      campaign TEXT DEFAULT '',
      campaign_id INTEGER,
      lost_reason TEXT DEFAULT '',
      won_invoice_id INTEGER,
      entered_stage_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS crm_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER,
      opportunity_id INTEGER,
      owner_user_id INTEGER,
      followup_id INTEGER,
      type TEXT NOT NULL DEFAULT 'note',
      subject TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT DEFAULT 'mid',
      activity_date TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      completed_at INTEGER,
      result TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_by INTEGER,
      changed_at INTEGER DEFAULT (strftime('%s','now')),
      duration_seconds INTEGER,
      reason TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS crm_customer_segments (
      customer_id INTEGER PRIMARY KEY,
      party_id INTEGER,
      calculated_segment TEXT NOT NULL DEFAULT 'C',
      manual_segment TEXT,
      effective_segment TEXT NOT NULL DEFAULT 'C',
      manual_override_reason TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      sales_30_rial INTEGER NOT NULL DEFAULT 0,
      sales_90_rial INTEGER NOT NULL DEFAULT 0,
      sales_365_rial INTEGER NOT NULL DEFAULT 0,
      purchase_count INTEGER NOT NULL DEFAULT 0,
      avg_purchase_rial INTEGER NOT NULL DEFAULT 0,
      last_purchase_date TEXT DEFAULT '',
      avg_cycle_days REAL,
      inactive_days INTEGER NOT NULL DEFAULT 0,
      churn_probability_percent INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_segment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      from_segment TEXT,
      to_segment TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'system',
      reason TEXT DEFAULT '',
      changed_by INTEGER,
      changed_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER,
      opportunity_id INTEGER,
      activity_id INTEGER,
      file_path TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      uploaded_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS crm_automation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_key TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      payload TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(rule_key, entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_opp_cust ON crm_opportunities(customer_id);
    CREATE INDEX IF NOT EXISTS idx_crm_opp_owner ON crm_opportunities(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_crm_opp_stage ON crm_opportunities(pipeline_stage, status);
    CREATE INDEX IF NOT EXISTS idx_crm_opp_source ON crm_opportunities(lead_source, campaign);
    CREATE INDEX IF NOT EXISTS idx_crm_act_cust ON crm_activities(customer_id);
    CREATE INDEX IF NOT EXISTS idx_crm_act_opp ON crm_activities(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_crm_act_status_due ON crm_activities(status, due_date);
    CREATE INDEX IF NOT EXISTS idx_crm_act_followup ON crm_activities(followup_id);
    CREATE INDEX IF NOT EXISTS idx_crm_hist_opp ON crm_stage_history(opportunity_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_crm_seg_eff ON crm_customer_segments(effective_segment);
    CREATE INDEX IF NOT EXISTS idx_crm_auto_rule ON crm_automation_log(rule_key, created_at);
  `);

  ensureColumn(db, 'followups', 'opportunity_id', 'INTEGER');
  ensureColumn(db, 'followups', 'party_id', 'INTEGER');
  ensureColumn(db, 'customers', 'lead_source', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'campaign', "TEXT DEFAULT ''");
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_followups_stage ON followups(pipeline_stage)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_followups_opportunity ON followups(opportunity_id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_lead_source ON invoices(lead_source)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_campaign ON invoices(campaign)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_status_del ON invoices(status, deleted_at)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_customers_party ON customers(party_id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_customers_province ON customers(province)'); } catch (_) {}

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key, value);
  }

  const srcCount = db.prepare('SELECT COUNT(*) AS c FROM crm_lead_sources').get()?.c || 0;
  if (srcCount === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO crm_lead_sources (code,label) VALUES (?,?)');
    for (const [code, label] of [
      ['instagram', 'اینستاگرام'],
      ['referral', 'معرفی'],
      ['visit', 'بازدید حضوری'],
      ['phone', 'تماس تلفنی'],
      ['exhibition', 'نمایشگاه'],
      ['website', 'وب‌سایت'],
      ['other', 'سایر'],
    ]) ins.run(code, label);
  }

  migrateFollowupsToOpportunities(db);
}

function migrateFollowupsToOpportunities(db) {
  const stamp = db.prepare('SELECT value FROM settings WHERE key=?').get(STAMP);
  const alreadyStamped = stamp?.value === '1';

  const now = Math.floor(Date.now() / 1000);
  let created = 0;
  const tx = db.transaction(() => {
    const customers = db.prepare(`
      SELECT DISTINCT c.id AS customer_id, c.user_id, c.party_id, c.biz, c.lead_source, c.campaign, c.source
      FROM customers c
      WHERE (
        EXISTS (SELECT 1 FROM followups f WHERE f.cust_id=c.id)
        OR EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.cust_id=c.id AND COALESCE(i.deleted_at,0)=0
            AND COALESCE(i.status,'posted')<>'reversed'
        )
      )
      AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.customer_id=c.id)
    `).all();

    const insOpp = db.prepare(`
      INSERT INTO crm_opportunities (
        party_id, customer_id, owner_user_id, title, pipeline_stage, status,
        estimated_amount_rial, probability_percent, weighted_amount_rial,
        lead_source, campaign, lost_reason, entered_stage_at, created_at, updated_at, closed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insAct = db.prepare(`
      INSERT INTO crm_activities (
        party_id, customer_id, opportunity_id, owner_user_id, followup_id,
        type, subject, description, status, priority, activity_date, due_date,
        result, next_action, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insHist = db.prepare(`
      INSERT INTO crm_stage_history (opportunity_id, from_stage, to_stage, changed_by, changed_at, duration_seconds, reason)
      VALUES (?,?,?,?,?,?,?)
    `);

    for (const c of customers) {
      const latest = db.prepare(`
        SELECT * FROM followups WHERE cust_id=? ORDER BY COALESCE(created_at,0) DESC, id DESC LIMIT 1
      `).get(c.customer_id);
      const firmCnt = db.prepare(`
        SELECT COUNT(*) AS c FROM invoices i
        WHERE i.cust_id=? AND i.type IN ('normal','final')
          AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
      `).get(c.customer_id)?.c || 0;

      let stage = normalizeStage(latest?.pipeline_stage);
      if (firmCnt >= 2 && stage !== 'lost') stage = 'repeat';
      else if (firmCnt === 1 && stage !== 'lost') stage = 'first_order';

      const prob = Math.max(0, Math.min(100, parseInt(latest?.purchase_prob, 10) || defaultProb(stage)));
      const closed = (stage === 'won' || stage === 'lost' || stage === 'repeat' || stage === 'first_order') ? now : null;
      const status = (stage === 'lost') ? 'lost' : (closed ? 'won' : 'open');
      const title = (latest?.subject || c.biz || 'فرصت فروش').slice(0, 200);
      const source = latest ? (c.lead_source || c.source || '') : (c.lead_source || c.source || '');

      const opp = insOpp.run(
        c.party_id || null, c.customer_id, latest?.user_id || c.user_id || null,
        title, stage, status === 'lost' ? 'lost' : (closed && stage !== 'lost' ? 'won' : 'open'),
        0, prob, 0,
        source, c.campaign || '', latest?.lost_reason || '',
        latest?.created_at || now, latest?.created_at || now, now, closed
      );
      const oppId = opp.lastInsertRowid;
      insHist.run(oppId, null, stage, latest?.user_id || c.user_id || null, latest?.created_at || now, null, 'migration');

      const fus = db.prepare('SELECT * FROM followups WHERE cust_id=? ORDER BY id').all(c.customer_id);
      for (const f of fus) {
        db.prepare('UPDATE followups SET opportunity_id=?, party_id=? WHERE id=?')
          .run(oppId, c.party_id || null, f.id);
        const exists = db.prepare('SELECT id FROM crm_activities WHERE followup_id=?').get(f.id);
        if (exists) continue;
        insAct.run(
          c.party_id || null, c.customer_id, oppId, f.user_id, f.id,
          mapFollowupType(f.type), f.subject || '', f.note || '',
          f.status || 'open', f.priority || 'mid', f.date || '', f.next_date || '',
          f.note || '', f.action || '', f.created_at || now, now
        );
      }
      created += 1;
    }

    if (!alreadyStamped) {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(STAMP, '1');
    }
  });
  tx();
  return { skipped: alreadyStamped, created };
}

function defaultProb(stage) {
  return ({
    lead: 10, qualified: 25, proposal: 40, negotiation: 60,
    first_order: 80, won: 100, repeat: 100, lost: 0,
  })[stage] || 10;
}

function mapFollowupType(type) {
  const t = String(type || '');
  if (/تلفن|call|☎|📱/i.test(t)) return 'call';
  if (/جلس|ملاقات|حضوری|visit|🏪/i.test(t)) return 'meeting';
  if (/واتس|تلگرام|اینستا|پیام|message|💬|📸|📲|✉️/i.test(t)) return 'message';
  if (/شکایت|complaint/i.test(t)) return 'complaint';
  if (/خدمات|service|کیفیت|فاکتور/i.test(t)) return 'service';
  if (/وظیفه|task/i.test(t)) return 'task';
  return 'note';
}

module.exports = {
  STAMP,
  DEFAULT_SETTINGS,
  STAGE_MAP,
  normalizeStage,
  defaultProb,
  mapFollowupType,
  initCrmProSchema,
  migrateFollowupsToOpportunities,
};
