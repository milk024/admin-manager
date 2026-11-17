'use strict';

// 네임스페이스 전체 YAML 관리 기능이 다룰 수 있는 Kind를 고정 화이트리스트로 제한한다.
// 이 기능은 사실상 "웹에서 kubectl apply"라 Kind 제한이 없으면 blast radius가 사실상
// cluster-admin과 같아진다 — 지금 실제로 각 서비스가 쓰는 리소스 종류만 허용한다.
// 새 Kind가 필요해지면 여기에 명시적으로 추가하는 방식으로 간다(암묵적 허용 없음).
//
// (결정) Secret은 영구 제외 — 값 자체를 다루는 순간 admin_manager가 클러스터에서 가장
// 민감한 데이터의 단일 장애/유출 지점이 된다. Secret은 관례대로 kubectl(예:
// `kubectl create secret generic ... --from-literal=...`)로만 발급/교체하고, 이 서버는
// 아예 관여하지 않는다 — Pod가 어떤 Secret을 참조하는지 "이름만" 보여주는 것까지만 한다
// (k8sAdminService.getPodRelatedResources 참고).
const KIND_API_VERSIONS = {
  Deployment: 'apps/v1',
  Service: 'v1',
  ConfigMap: 'v1',
  PersistentVolumeClaim: 'v1',
  NetworkPolicy: 'networking.k8s.io/v1',
  HTTPRoute: 'gateway.networking.k8s.io/v1',
};

// 수정(patch) 방식. 내장 리소스는 strategic merge patch(목록을 이름 기준으로 합침)를 지원하지만
// CRD(HTTPRoute 등)는 지원하지 않아 415 로 거절한다 → merge patch(RFC 7386)로 보낸다.
// merge patch 에서 목록(rules, hostnames, parentRefs 등)은 통째로 바뀌고, 빠진 필드는 그대로 남는다
// (필드를 지우려면 값을 null 로).
const MERGE_PATCH_KINDS = new Set(['HTTPRoute']);

class ManifestWhitelistHelper {
  isAllowed(kind) {
    return Object.prototype.hasOwnProperty.call(KIND_API_VERSIONS, kind);
  }

  list() {
    return Object.keys(KIND_API_VERSIONS);
  }

  apiVersionFor(kind) {
    this.assertAllowed(kind);
    return KIND_API_VERSIONS[kind];
  }

  patchStrategyFor(kind) {
    this.assertAllowed(kind);
    return MERGE_PATCH_KINDS.has(kind) ? 'merge' : 'strategic';
  }

  // 화이트리스트의 apiVersion 과 다르면 거부 (같은 Kind 의 다른 API 그룹·버전으로 우회 방지)
  assertApiVersion(kind, apiVersion) {
    const expected = this.apiVersionFor(kind);
    if (apiVersion !== expected) {
      const err = new Error(`${kind} 의 apiVersion 은 ${expected} 이어야 합니다 (받은 값: ${apiVersion})`);
      err.code = 400;
      throw err;
    }
  }

  assertAllowed(kind) {
    if (!this.isAllowed(kind)) {
      const err = new Error(`허용되지 않은 Kind입니다: ${kind} (허용 목록: ${this.list().join(', ')})`);
      err.code = 400;
      throw err;
    }
  }
}

module.exports = new ManifestWhitelistHelper();
