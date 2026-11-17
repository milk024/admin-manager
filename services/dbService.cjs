'use strict';

const { Pool } = require('pg');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');

// ADR 예정: k8s_manager와 같은 Postgres 인스턴스(Gitea용)를 재사용하되, DB/계정은
// admin_manager 전용으로 완전히 분리한다 — 권한 격리가 이 서버를 분리한 목적이므로
// DB 레벨에서도 같은 원칙을 유지한다 (Gitea DB나 k8s_manager DB와 스키마 공유 없음).
class DbService {
  constructor() {
    this.pool = new Pool(config.db);
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  // 마이그레이션 도구 없이 CREATE TABLE IF NOT EXISTS로 시작 — 스키마 변경이 잦아지면
  // 그때 정식 마이그레이션 도구 도입을 검토한다 (지금 규모엔 과함).
  async init() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // 발급한 개발자 계정(ServiceAccount) 이력 — 감사 목적 + 목록 조회용.
    // revoked_at이 NULL이면 아직 살아있는 것으로 취급.
    await this.query(`
      CREATE TABLE IF NOT EXISTS account_issuances (
        id SERIAL PRIMARY KEY,
        namespace TEXT NOT NULL,
        service_account TEXT NOT NULL,
        rbac_template TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at TIMESTAMPTZ
      )
    `);
    // 같은 이름은 "회수되지 않은 발급"끼리만 겹치지 않게 한다 — 회수 후 같은 이름으로 재발급할 수 있어야 하고,
    // 이력(회수된 행)은 그대로 남긴다. 예전 스키마의 테이블 전체 UNIQUE 제약은 제거.
    await this.query('ALTER TABLE account_issuances DROP CONSTRAINT IF EXISTS account_issuances_namespace_service_account_key');
    await this.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS account_issuances_active_uniq
        ON account_issuances (namespace, service_account) WHERE revoked_at IS NULL
    `);
    await this.query('ALTER TABLE account_issuances ADD COLUMN IF NOT EXISTS revoked_by TEXT');

    // 네임스페이스 YAML 관리 기능으로 적용/삭제한 이력 — 누가 언제 뭘 바꿨는지 추적.
    await this.query(`
      CREATE TABLE IF NOT EXISTS manifest_history (
        id SERIAL PRIMARY KEY,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        action TEXT NOT NULL,
        applied_by TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        manifest JSONB
      )
    `);

    // 관리 작업 이력(감사 로그) — 로그인, 계정 발급/회수, YAML 적용/삭제, 관리자 추가, (예정) Gitea 관리.
    // 성공·실패 모두 남긴다. 비밀값은 넣지 않는다 (auditService 참고).
    await this.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor TEXT NOT NULL,
        ip TEXT,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
        detail JSONB
      )
    `);
    await this.query('CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, id DESC)');
    await this.query('CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, id DESC)');

    // audit_log 가 생기기 전 기록(발급/회수, YAML 적용)을 처음 한 번만 옮겨 둔다
    const { rows } = await this.query('SELECT EXISTS (SELECT 1 FROM audit_log) AS has');
    if (!rows[0].has) {
      await this.query(`
        INSERT INTO audit_log (at, actor, action, target, result, detail)
        SELECT at, actor, action, target, 'success', detail FROM (
          SELECT issued_at AS at, issued_by AS actor, 'account.issue' AS action,
                 namespace || '/' || service_account AS target,
                 jsonb_build_object('rbacTemplate', rbac_template, 'migrated', true) AS detail
            FROM account_issuances
          UNION ALL
          SELECT revoked_at, COALESCE(revoked_by, '-'), 'account.revoke', namespace || '/' || service_account,
                 jsonb_build_object('migrated', true)
            FROM account_issuances WHERE revoked_at IS NOT NULL
          UNION ALL
          SELECT applied_at, applied_by, 'manifest.' || CASE WHEN action = 'delete' THEN 'delete' ELSE 'apply' END,
                 namespace || '/' || kind || '/' || name,
                 jsonb_build_object('op', action, 'migrated', true)
            FROM manifest_history
        ) old ORDER BY at
      `);
    }

    logHelper.info('DbService', '스키마 확인/초기화 완료');
  }
}

module.exports = new DbService();
