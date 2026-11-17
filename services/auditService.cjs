'use strict';

const dbService = require('./dbService.cjs');
const logHelper = require('../helpers/logHelper.cjs');

// 관리 작업 이력(감사 로그). 누가(actor) 어디서(ip) 무엇을(action) 어디에(target) 했고 결과가 어땠는지 남긴다.
//   action 예: auth.login, account.issue, account.revoke, manifest.apply, manifest.delete, admin.create
//   (이후 Gitea 관리 기능도 gitea.* 로 같은 테이블에 남긴다)
// detail 에는 비밀값(토큰·비밀번호·kubeconfig)을 절대 넣지 않는다.
// 기록 실패가 본 작업을 실패시키지는 않는다 — 경고 로그만 남긴다.
const MAX_LIMIT = 200;

class AuditService {
  async record({ actor, ip, action, target = null, result, detail = null }) {
    try {
      await dbService.query(
        `INSERT INTO audit_log (actor, ip, action, target, result, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actor || '-', ip || null, action, target, result, detail ? JSON.stringify(detail) : null],
      );
    } catch (err) {
      logHelper.warn('AuditService', `이력 기록 실패 (${action} ${target}): ${err.message}`);
    }
  }

  // 라우터에서 작업을 감싸 성공/실패를 모두 남긴다. 실패하면 오류를 그대로 다시 던진다.
  async run(req, action, target, detail, fn) {
    const base = { actor: req.admin?.sub, ip: req.ip, action, target };
    try {
      const out = await fn();
      await this.record({ ...base, result: 'success', detail });
      return out;
    } catch (err) {
      await this.record({ ...base, result: 'failure', detail: { ...(detail || {}), error: err.message } });
      throw err;
    }
  }

  // 최신순. before(id) 를 주면 그보다 오래된 것부터 (페이지 넘김)
  async list({ action, actor, target, result, before, limit } = {}) {
    const where = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (action) add(action.endsWith('.*') ? 'action LIKE ?' : 'action = ?', action.endsWith('.*') ? `${action.slice(0, -1)}%` : action);
    if (actor) add('actor = ?', actor);
    if (target) add('target ILIKE ?', `%${target}%`);
    if (result) add('result = ?', result);
    if (before) add('id < ?', Number(before));
    const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
    params.push(n);
    const { rows } = await dbService.query(
      `SELECT id, at, actor, ip, action, target, result, detail FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }
}

module.exports = new AuditService();
