'use strict';

const express = require('express');
const auditService = require('../../services/auditService.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');

// 관리 작업 이력 조회. 쓰기는 각 라우터가 auditService 로 직접 남긴다 (여기선 조회만).
//   GET /api/audit?action=account.*&actor=&target=&result=failure&before=<id>&limit=50
const router = express.Router();
router.use(authMiddlewareHelper.requireAdmin());

router.get('/', async (req, res, next) => {
  try {
    const { action, actor, target, result, before, limit } = req.query;
    if (result && !['success', 'failure'].includes(result)) {
      return res.status(400).json({ error: 'result 는 success 또는 failure 입니다' });
    }
    if (before && !/^\d+$/.test(before)) {
      return res.status(400).json({ error: 'before 는 숫자(id)입니다' });
    }
    res.json(await auditService.list({ action, actor, target, result, before, limit }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
