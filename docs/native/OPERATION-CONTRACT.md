# OPERATION-CONTRACT — قرارداد عملیات سینک (تولید خودکار)

> **تولید:** `node scripts/native/generate-operation-contract.js`
> **SHA-256 محتوا:** `5c27a2b1b46142359ef3ad569b9ea4e9d8fddd1973011a685ae6a9985a638ff0`

این فایل را دستی ویرایش نکنید. هر تغییر در `capture.js` / `tables.js` باید دوباره تولید و در CI بدون diff باشد.

## شمارش‌ها

| شاخص | مقدار |
|---|---|
| فایل‌های route | 81 |
| endpoint mutating (تقریبی) | 473 |
| GET / POST / PUT / PATCH / DELETE | 406 / 326 / 62 / 10 / 75 |
| جداول syncable | 170 |
| PATH_TABLE_MAP | 97 |
| FK_COLUMNS | 259 |

## فضای شناسه

```
PROVISIONAL_FLOOR=1000000000000
DEVICE_SPAN=100000000
TABLE_SPAN=1000000
LEGACY_TABLE_SLOTS=100
OVERFLOW_FLOOR=1010000000000
```

## BLOCKLIST (پیشوند مسیر)

- `/api/auth`
- `/api/users`
- `/api/sync`
- `/api/api-keys`
- `/api/messages`
- `/api/v1`
- `/api/ai`
- `/api/b2b`
- `/api/onboarding`
- `/api/excel`
- `/api/admin/backup`
- `/api/admin/backups`
- `/api/admin/backup-now`
- `/api/admin/backup-download`
- `/api/admin/backup-restore`
- `/api/admin/backup-schedule`
- `/api/admin/backup-purge`
- `/api/admin/restore-product-stock-wipe`
- `/api/crm/automations`

## BLOCK_PATTERNS

- `/\/import/`
- `/\/export/`
- `/\/backup/`
- `/\/backfill/`
- `/\/stock$/`

## PATH_TABLE_MAP (خاص قبل از عام)

| پیشوند | جدول |
|---|---|
| `/api/admin/users` | `users` |
| `/api/settings` | `settings` |
| `/api/rbac/matrix` | `user_permissions` |
| `/api/accounting/settlements` | `settlements` |
| `/api/accounting/account-payments` | `journal_entries` |
| `/api/accounting/account-receipts` | `journal_entries` |
| `/api/accounting/sales-returns` | `sales_returns` |
| `/api/accounting/invoices` | `invoices` |
| `/api/accounting/vouchers/drafts` | `voucher_drafts` |
| `/api/accounting/vouchers/templates` | `journal_templates` |
| `/api/accounting/vouchers` | `journal_entries` |
| `/api/accounting/cost-centers` | `cost_centers` |
| `/api/accounting/customer-groups` | `customer_groups` |
| `/api/purchases/returns` | `purchase_returns` |
| `/api/purchases/payments` | `supplier_payments` |
| `/api/purchases/goods-receipts` | `goods_receipts` |
| `/api/purchases/orders` | `purchase_orders` |
| `/api/purchases/three-way-match` | `three_way_matches` |
| `/api/purchases/gr-invoices` | `purchase_invoices` |
| `/api/purchases` | `purchase_invoices` |
| `/api/rfq` | `rfqs` |
| `/api/branches` | `branches` |
| `/api/persons/categories` | `person_categories` |
| `/api/persons` | `persons` |
| `/api/customers` | `customers` |
| `/api/parties` | `parties` |
| `/api/invoices` | `invoices` |
| `/api/followups` | `followups` |
| `/api/crm/opportunities` | `crm_opportunities` |
| `/api/crm/activities` | `crm_activities` |
| `/api/crm/segmentation` | `crm_customer_segments` |
| `/api/product-variants/colors` | `product_colors` |
| `/api/product-variants/sizes` | `product_sizes` |
| `/api/product-variants/generate-matrix` | `product_variants` |
| `/api/product-variants/stock-matrix` | `product_variants` |
| `/api/product-variants/ensure-default` | `product_variants` |
| `/api/product-variants/style` | `product_variants` |
| `/api/product-variants` | `product_variants` |
| `/api/products` | `products` |
| `/api/product-categories` | `product_categories` |
| `/api/suppliers` | `suppliers` |
| `/api/banks` | `banks` |
| `/api/cash-boxes` | `cash_boxes` |
| `/api/check-categories` | `check_categories` |
| `/api/expenses` | `expense_payments` |
| `/api/transfers` | `account_transfers` |
| `/api/trust-checks` | `trust_checks` |
| `/api/warehouses/moves` | `warehouse_moves` |
| `/api/warehouses/stock` | `warehouse_stock` |
| `/api/warehouses` | `warehouses` |
| `/api/stocktaking` | `stocktaking_sessions` |
| `/api/consignments` | `consignments` |
| `/api/pos/receipts` | `pos_receipts` |
| `/api/pos/batches` | `pos_settlement_batches` |
| `/api/pos/terminals` | `pos_terminals` |
| `/api/detail-accounts/categories` | `detail_categories` |
| `/api/detail-accounts` | `detail_accounts` |
| `/api/units` | `units_of_measure` |
| `/api/fixed-assets` | `fixed_assets` |
| `/api/production/cost-centers/rates` | `cost_center_rates` |
| `/api/production/boms` | `bom_headers` |
| `/api/production/orders` | `production_orders` |
| `/api/production/execution` | `production_orders` |
| `/api/production/cutting-lays` | `cutting_lays` |
| `/api/production/mrp` | `mrp_runs` |
| `/api/production/cost-centers` | `cost_centers` |
| `/api/production/user-cost-centers` | `user_cost_centers` |
| `/api/production/close` | `production_period_close` |
| `/api/production` | `production_runs` |
| `/api/inventory/fabric-rolls` | `inventory_batches` |
| `/api/inventory/batches` | `inventory_batches` |
| `/api/inventory/serials` | `inventory_serials` |
| `/api/inventory/reservations` | `inventory_reservations` |
| `/api/inventory/landed-cost` | `landed_cost_docs` |
| `/api/inventory/ledger` | `inventory_ledger` |
| `/api/inventory/adjust` | `inventory_ledger` |
| `/api/payroll/employee-groups` | `employee_groups` |
| `/api/payroll/group-salary-structures` | `group_salary_structures` |
| `/api/payroll` | `payroll_records` |
| `/api/reminders` | `reminders` |
| `/api/orders` | `orders` |
| `/api/party-groups` | `party_groups` |
| `/api/fx/rates` | `exchange_rates` |
| `/api/fx/currencies` | `currencies` |
| `/api/person-positions` | `person_positions` |
| `/api/pricing-rules` | `pricing_rules` |
| `/api/portal/parameters` | `op_parameters` |
| `/api/portal/units` | `op_units` |
| `/api/portal/departments` | `op_departments` |
| `/api/bank-reconciliation` | `bank_reconciliations` |
| `/api/budgeting` | `budgets` |
| `/api/reserves` | `legal_reserve_entries` |
| `/api/cheque-records` | `cheque_records` |
| `/api/sms-module/rules` | `sms_rules` |
| `/api/sms-module/templates` | `sms_templates` |
| `/api/sms-module/options` | `sms_options` |
| `/api/sms-module/scheduled` | `sms_scheduled` |

## SYNCABLE_TABLES (append-only — ترتیب مقدس)

| # | جدول | upsertKey | compositeKeys |
|---|---|---|---|
| 0 | `users` | `id` | — |
| 1 | `settings` | `key` | — |
| 2 | `chart_of_accounts` | `code` | — |
| 3 | `customer_groups` | `id` | — |
| 4 | `person_categories` | `id` | — |
| 5 | `cost_centers` | `id` | — |
| 6 | `warehouses` | `id` | — |
| 7 | `banks` | `id` | — |
| 8 | `cash_boxes` | `id` | — |
| 9 | `check_categories` | `id` | — |
| 10 | `suppliers` | `id` | — |
| 11 | `customers` | `id` | — |
| 12 | `persons` | `id` | — |
| 13 | `products` | `id` | — |
| 14 | `orders` | `id` | — |
| 15 | `followups` | `id` | — |
| 16 | `invoices` | `id` | — |
| 17 | `settlements` | `id` | — |
| 18 | `sales_returns` | `id` | — |
| 19 | `purchase_invoices` | `id` | — |
| 20 | `purchase_returns` | `id` | — |
| 21 | `supplier_payments` | `id` | — |
| 22 | `expense_payments` | `id` | — |
| 23 | `account_transfers` | `id` | — |
| 24 | `trust_checks` | `id` | — |
| 25 | `warehouse_moves` | `id` | — |
| 26 | `consignments` | `id` | — |
| 27 | `production_runs` | `id` | — |
| 28 | `payroll_records` | `id` | — |
| 29 | `incentive_payments` | `id` | — |
| 30 | `stock_logs` | `id` | — |
| 31 | `customer_ledger` | `id` | — |
| 32 | `supplier_ledger` | `id` | — |
| 33 | `person_ledger` | `id` | — |
| 34 | `journal_entries` | `id` | — |
| 35 | `journal_lines` | `id` | — |
| 36 | `journal_templates` | `id` | — |
| 37 | `voucher_drafts` | `id` | — |
| 38 | `messages` | `id` | — |
| 39 | `reminders` | `id` | — |
| 40 | `product_categories` | `id` | — |
| 41 | `warehouse_stock` | `product_id:warehouse_id` | `product_id,warehouse_id` |
| 42 | `rep_assignment_history` | `id` | — |
| 43 | `rep_ledger` | `id` | — |
| 44 | `rep_expenses` | `id` | — |
| 45 | `rep_advances` | `id` | — |
| 46 | `rep_commission_rules` | `id` | — |
| 47 | `rep_commission_tiers` | `id` | — |
| 48 | `rep_settlements` | `id` | — |
| 49 | `rep_territories` | `id` | — |
| 50 | `rep_visit_logs` | `id` | — |
| 51 | `rep_call_logs` | `id` | — |
| 52 | `stocktaking_sessions` | `id` | — |
| 53 | `stocktaking_items` | `id` | — |
| 54 | `parties` | `id` | — |
| 55 | `detail_categories` | `id` | — |
| 56 | `detail_accounts` | `id` | — |
| 57 | `fiscal_years` | `id` | — |
| 58 | `units_of_measure` | `id` | — |
| 59 | `bom_headers` | `id` | — |
| 60 | `bom_lines` | `id` | — |
| 61 | `bom_operations` | `id` | — |
| 62 | `bom_outputs` | `id` | — |
| 63 | `bom_change_log` | `id` | — |
| 64 | `cost_center_rates` | `id` | — |
| 65 | `overhead_allocation_rules` | `id` | — |
| 66 | `overhead_allocation_weights` | `id` | — |
| 67 | `production_orders` | `id` | — |
| 68 | `production_order_stages` | `id` | — |
| 69 | `production_material_issues` | `id` | — |
| 70 | `production_labor_entries` | `id` | — |
| 71 | `production_overhead_applications` | `id` | — |
| 72 | `production_waste` | `id` | — |
| 73 | `production_rework` | `id` | — |
| 74 | `production_receipts` | `id` | — |
| 75 | `production_subcontract` | `id` | — |
| 76 | `production_variances` | `id` | — |
| 77 | `production_period_close` | `period_label` | — |
| 78 | `production_estimates` | `id` | — |
| 79 | `production_estimate_lines` | `id` | — |
| 80 | `mrp_runs` | `id` | — |
| 81 | `mrp_requirements` | `id` | — |
| 82 | `production_reservations` | `id` | — |
| 83 | `inventory_ledger` | `id` | — |
| 84 | `inventory_cost_layers` | `id` | — |
| 85 | `inventory_batches` | `id` | — |
| 86 | `inventory_serials` | `id` | — |
| 87 | `inventory_reservations` | `id` | — |
| 88 | `landed_cost_docs` | `id` | — |
| 89 | `landed_cost_lines` | `id` | — |
| 90 | `landed_cost_allocations` | `id` | — |
| 91 | `payroll_periods` | `id` | — |
| 92 | `salary_structures` | `id` | — |
| 93 | `payroll_tax_brackets` | `id` | — |
| 94 | `payroll_year_end_bonuses` | `id` | — |
| 95 | `projects` | `id` | — |
| 96 | `report_configurations` | `id` | — |
| 97 | `vat_records` | `id` | — |
| 98 | `currencies` | `code` | — |
| 99 | `exchange_rates` | `id` | — |
| 100 | `person_positions` | `id` | — |
| 101 | `pricing_rules` | `id` | — |
| 102 | `op_units` | `id` | — |
| 103 | `op_unit_warehouses` | `id` | — |
| 104 | `op_unit_persons` | `id` | — |
| 105 | `op_departments` | `id` | — |
| 106 | `op_parameters` | `id` | — |
| 107 | `op_parameter_items` | `id` | — |
| 108 | `op_parameter_dept_log` | `id` | — |
| 109 | `bank_reconciliations` | `id` | — |
| 110 | `bank_reconciliation_items` | `id` | — |
| 111 | `doubtful_debt_provisions` | `id` | — |
| 112 | `inventory_nrv_provisions` | `id` | — |
| 113 | `inventory_nrv_lines` | `id` | — |
| 114 | `legal_reserve_entries` | `id` | — |
| 115 | `payroll_labor_settings` | `id` | — |
| 116 | `payroll_monthly_accruals` | `id` | — |
| 117 | `budgets` | `id` | — |
| 118 | `budget_lines` | `id` | — |
| 119 | `op_dept_capabilities` | `id` | — |
| 120 | `op_dept_tasks` | `id` | — |
| 121 | `op_unit_module_links` | `id` | — |
| 122 | `op_parameter_extra_costs` | `id` | — |
| 123 | `op_field_followups` | `id` | — |
| 124 | `expense_categories` | `id` | — |
| 125 | `op_dept_delegations` | `id` | — |
| 126 | `product_images` | `id` | — |
| 127 | `user_catalog_categories` | `id` | — |
| 128 | `sms_templates` | `id` | — |
| 129 | `sms_options` | `id` | — |
| 130 | `sms_scheduled` | `id` | — |
| 131 | `marketer_carts` | `id` | — |
| 132 | `party_groups` | `id` | — |
| 133 | `cheque_records` | `id` | — |
| 134 | `fixed_assets` | `id` | — |
| 135 | `fixed_asset_depreciation` | `id` | — |
| 136 | `user_cost_centers` | `user_id:cost_center_id` | `user_id,cost_center_id` |
| 137 | `rep_payment_submissions` | `id` | — |
| 138 | `sms_rules` | `id` | — |
| 139 | `employee_groups` | `id` | — |
| 140 | `group_salary_structures` | `id` | — |
| 141 | `bank_statement_lines` | `id` | — |
| 142 | `product_colors` | `id` | — |
| 143 | `product_sizes` | `id` | — |
| 144 | `product_style_colors` | `id` | — |
| 145 | `product_style_sizes` | `id` | — |
| 146 | `product_variants` | `id` | — |
| 147 | `crm_lead_sources` | `id` | — |
| 148 | `crm_campaigns` | `id` | — |
| 149 | `crm_opportunities` | `id` | — |
| 150 | `crm_activities` | `id` | — |
| 151 | `crm_stage_history` | `id` | — |
| 152 | `crm_customer_segments` | `customer_id` | `customer_id` |
| 153 | `crm_segment_history` | `id` | — |
| 154 | `crm_files` | `id` | — |
| 155 | `pos_terminals` | `id` | — |
| 156 | `pos_receipts` | `id` | — |
| 157 | `pos_settlement_batches` | `id` | — |
| 158 | `pos_settlement_items` | `id` | — |
| 159 | `cutting_lays` | `id` | — |
| 160 | `cutting_lay_rolls` | `id` | — |
| 161 | `branches` | `id` | — |
| 162 | `rfqs` | `id` | — |
| 163 | `purchase_orders` | `id` | — |
| 164 | `goods_receipts` | `id` | — |
| 165 | `three_way_matches` | `id` | — |
| 166 | `cutting_packs` | `id` | — |
| 167 | `cutting_pack_bundles` | `id` | — |
| 168 | `inventory_movements` | `id` | — |
| 169 | `variant_warehouse_stock` | `variant_id:warehouse_id` | `variant_id,warehouse_id` |

## نمونه tableForPath

```json
{
  "/api/customers": "customers",
  "/api/invoices/1": "invoices",
  "/api/warehouses/moves": "warehouse_moves",
  "/api/warehouses": "warehouses"
}
```

فایل ماشین‌خوان: [`OPERATION-CONTRACT.json`](./OPERATION-CONTRACT.json)
