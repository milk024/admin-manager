'use strict';

const os = require('os');
const path = require('path');

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

class ConfigHelper {
  constructor() {
    this.port = Number(readEnv('PORT', 8100));
    this.allowedOrigins = readEnv('ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    // k8s_manager와 동일 패턴: 운영(in-cluster ServiceAccount) / 로컬 개발(kubeconfig 폴백).
    this.kubeconfigPath = readEnv('KUBECONFIG', path.join(os.homedir(), '.kube', 'config'));

    // admin-manager 전용 논리 DB — k8s_manager와 같은 Postgres 인스턴스, 별도 DB/계정 (권한 격리).
    this.db = {
      host: readEnv('PGHOST', 'gitea-postgresql.infra.svc.cluster.local'),
      port: Number(readEnv('PGPORT', 5432)),
      database: readEnv('PGDATABASE', 'admin_manager'),
      user: readEnv('PGUSER', 'admin_manager'),
      password: readEnv('PGPASSWORD', ''),
    };

    this.jwt = {
      secret: readEnv('JWT_SECRET', ''),
      expiresIn: readEnv('JWT_EXPIRES_IN', '8h'),
    };

    // 최초 1회 부트스트랩 관리자 계정 — admin_users 테이블이 비어있을 때만 사용됨.
    this.adminBootstrap = {
      username: readEnv('ADMIN_BOOTSTRAP_USERNAME', ''),
      password: readEnv('ADMIN_BOOTSTRAP_PASSWORD', ''),
    };
  }
}

module.exports = new ConfigHelper();
