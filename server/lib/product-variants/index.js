'use strict';

const schema = require('./schema');
const service = require('./service');

module.exports = {
  ...schema,
  ...service,
};
