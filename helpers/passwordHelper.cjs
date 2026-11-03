'use strict';

const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

class PasswordHelper {
  async hash(plainText) {
    return bcrypt.hash(plainText, SALT_ROUNDS);
  }

  async verify(plainText, hash) {
    return bcrypt.compare(plainText, hash);
  }
}

module.exports = new PasswordHelper();
