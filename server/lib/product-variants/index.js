'use strict';

const schema = require('./schema');
const service = require('./service');
const colorHex = require('./color-hex');

module.exports = {
  ...schema,
  ...service,
  ...colorHex,
};
