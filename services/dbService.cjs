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
        revoked_at TIMESTAMPTZ,
        UNIQUE (namespace, service_account)
      )
    `);

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

    logHelper.info('DbService', '스키마 확인/초기화 완료');
  }
}

module.exports = new DbService();
