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

    // 발급하는 개발자 kubeconfig 에 넣을 API 서버 주소. in-cluster 주소(10.96.0.1)는 개발자 PC 에서
    // 접속할 수 없으므로 외부에서 닿는 주소를 지정한다 (예: https://10.0.0.20:6443). 비우면 현재 클러스터 주소.
    this.publicApiServer = readEnv('K8S_PUBLIC_API_SERVER', '');

    // 개발자 계정을 발급할 수 있는 네임스페이스 (쉼표 구분). 배포 차트의 rbac.namespaces 와 같은 목록으로 채운다.
    // admin-manager 에 RoleBinding 이 없는 곳에 발급하면 어차피 K8s 가 403 으로 막지만, 화면 선택지와
    // 사전 검증에 쓴다. 비우면 제한 없음(로컬 개발용).
    this.issuableNamespaces = readEnv('ISSUABLE_NAMESPACES', '')
      .split(',')
      .map((ns) => ns.trim())
      .filter(Boolean);

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

    // Gitea 사용자·팀 관리 (giteaAdminService). 토큰은 site admin 계정 gitea-mgmt-svc 의 것 (Secret admin-manager-gitea-mgmt).
    // 비우면 Gitea 관리 API 는 503.
    this.gitea = {
      baseUrl: readEnv('GITEA_BASE_URL', '').replace(/\/+$/, ''),
      token: readEnv('GITEA_MGMT_TOKEN', ''),
      org: readEnv('GITEA_ORG', 'myorg'),
      // 여기서 구성원을 바꿀 수 없는 팀, 그리고 그 구성원 계정은 어떤 변경도 거부 (끝의 * 는 접두어)
      protectedTeams: readEnv('GITEA_PROTECTED_TEAMS', 'Owners,ci-*,svc-*').split(',').map((t) => t.trim()).filter(Boolean),
    };

    // 최초 1회 부트스트랩 관리자 계정 — admin_users 테이블이 비어있을 때만 사용됨.
    this.adminBootstrap = {
      username: readEnv('ADMIN_BOOTSTRAP_USERNAME', ''),
      password: readEnv('ADMIN_BOOTSTRAP_PASSWORD', ''),
    };
  }
}

module.exports = new ConfigHelper();
