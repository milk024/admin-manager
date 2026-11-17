'use strict';

const express = require('express');
const authService = require('../../services/authService.cjs');
const auditService = require('../../services/auditService.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');
const loginRateLimitHelper = require('../../helpers/loginRateLimitHelper.cjs');
const logHelper = require('../../helpers/logHelper.cjs');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username, password는 필수입니다' });
    }
    const wait = loginRateLimitHelper.retryAfterSeconds(req.ip, username);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      await auditService.record({ actor: username, ip: req.ip, action: 'auth.login', result: 'failure', detail: { reason: 'locked' } });
      return res.status(429).json({ error: `로그인 실패가 많아 잠시 잠겼습니다. ${Math.ceil(wait / 60)}분 뒤 다시 시도하세요` });
    }
    try {
      const result = await authService.login(username, password);
      loginRateLimitHelper.recordSuccess(req.ip, username);
      await auditService.record({ actor: username, ip: req.ip, action: 'auth.login', result: 'success' });
      return res.json(result);
    } catch (err) {
      loginRateLimitHelper.recordFailure(req.ip, username);
      // 실패 사유(없는 계정/비밀번호 틀림)는 이력에도 구분해 남기지 않는다 — 응답과 같은 수준
      await auditService.record({ actor: username, ip: req.ip, action: 'auth.login', result: 'failure', detail: { reason: 'bad_credentials' } });
      logHelper.warn('Auth', `로그인 실패: user=${username} ip=${req.ip}`);
      // 아이디가 없는지 비밀번호가 틀렸는지 구분하지 않는다 (계정 존재 여부 노출 방지)
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
    }
  } catch (err) {
    return next(err);
  }
});

// 이미 인증된 관리자만 다른 관리자 계정을 추가할 수 있다 — 최초 계정은 부트스트랩으로만 생성.
router.post('/admins', authMiddlewareHelper.requireAdmin(), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username, password는 필수입니다' });
    }
    await auditService.run(req, 'admin.create', username, null, () => authService.createAdmin(username, password));
    res.status(201).json({ username });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
