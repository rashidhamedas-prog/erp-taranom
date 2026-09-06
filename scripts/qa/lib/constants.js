'use strict';

const ADMIN_USER = 'admin';
const ADMIN_BOOTSTRAP_PASS = 'admin123';
const ADMIN_PASS = 'QaAdmin#1405';
const ROLE_PASS = 'QaRole#1405';
const QA_DATE = '1405/06/02';
const QA_JWT = 'erp-qa-isolation-jwt-secret-32chars!!';

const PROD_PATH_SNIPPETS = [
  '/home/taranom',
  '/home/taranom-admin',
  '94.249.244.208',
  '45.90.98.99',
  'erp.poshaktaranom.com',
  'poshaktaranom.com',
  'server\\crm.db',
  'server/crm.db',
  'crm-taranom/server/crm.db',
];

const PROD_HOSTS = [
  'erp.poshaktaranom.com',
  'poshaktaranom.com',
  '94.249.244.208',
  '45.90.98.99',
];

module.exports = {
  ADMIN_USER, ADMIN_BOOTSTRAP_PASS, ADMIN_PASS, ROLE_PASS, QA_DATE, QA_JWT,
  PROD_PATH_SNIPPETS, PROD_HOSTS,
};
