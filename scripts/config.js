'use strict';

const fs = require('fs');
const path = require('path');

const universalConfig = require('../config.json');
let userConfig = {};
try {
  const json = fs.readFileSync(
    path.join(__dirname, '../config.local.json'),
    'utf8');
  userConfig = JSON.parse(json);
} catch (e) {
  // If the file does not exist, then that's fine, but if it contains malformed
  // JSON, then the user should know.
  if (e.code !== 'ENOENT') {
    throw e;
  }
}

module.exports = Object.assign({}, universalConfig, userConfig);
