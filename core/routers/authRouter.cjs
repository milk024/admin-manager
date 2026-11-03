'use strict';

const express = require('express');
const authService = require('../../services/authService.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username, password는 필수입니다' });
    }
    const result = await authService.login(username, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// 이미 인증된 관리자만 다른 관리자 계정을 추가할 수 있다 — 최초 계정은 부트스트랩으로만 생성.
router.post('/admins', authMiddlewareHelper.requireAdmin(), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username, password는 필수입니다' });
    }
    await authService.createAdmin(username, password);
    res.status(201).json({ username });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
