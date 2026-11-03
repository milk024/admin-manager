'use strict';

const jwt = require('jsonwebtoken');
const config = require('./configHelper.cjs');

class JwtHelper {
  sign(payload) {
    if (!config.jwt.secret) {
      throw new Error('JWT_SECRET이 설정되지 않았습니다 — .env에 반드시 채워야 함');
    }
    return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  }

  verify(token) {
    return jwt.verify(token, config.jwt.secret);
  }
}

module.exports = new JwtHelper();
