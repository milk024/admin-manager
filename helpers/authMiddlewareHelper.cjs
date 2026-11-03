'use strict';

const jwtHelper = require('./jwtHelper.cjs');

// 관리자 인증이 필요한 모든 라우터(accountRouter, manifestRouter)에 붙이는 미들웨어.
// Authorization: Bearer <token> 형태만 지원 — 세션/쿠키는 쓰지 않는다(서버가 상태를 안 들고 있어도 됨).
class AuthMiddlewareHelper {
  requireAdmin() {
    return (req, res, next) => {
      const header = req.get('authorization') || '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: '인증 토큰이 필요합니다' });
      }
      try {
        req.admin = jwtHelper.verify(token);
        return next();
      } catch (err) {
        return res.status(401).json({ error: `유효하지 않은 토큰: ${err.message}` });
      }
    };
  }
}

module.exports = new AuthMiddlewareHelper();
