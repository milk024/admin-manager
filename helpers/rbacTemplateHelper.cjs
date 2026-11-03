'use strict';

// 개발자 계정 발급 시 자유 입력이 아니라 이 템플릿 중에서만 고르게 한다 — UI에서 임의 권한을
// 조립할 수 있게 하면 admin-manager 자신이 가진 권한 이상을 실수로 요청하는 경우가 생기고,
// K8s RBAC의 privilege-escalation 방지 규칙에 걸려 실패하거나(운영 혼란) 반대로
// admin-manager 자체 ClusterRole을 계속 넓혀야 하는 악순환이 생긴다. 템플릿을 고정해두면
// admin-manager의 ClusterRole도 "이 템플릿들의 합집합"으로 딱 필요한 만큼만 유지할 수 있다.
const TEMPLATES = {
  readonly: {
    description: '조회 전용 — Pod/Deployment/Service/ConfigMap/Event 등 get/list/watch만',
    rules: [
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log', 'services', 'configmaps', 'events', 'persistentvolumeclaims'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'replicasets'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },
  'namespace-write': {
    description: '해당 네임스페이스 안에서 배포 관련 리소스 생성/수정/삭제 (Secret 등 민감 리소스는 제외)',
    rules: [
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log', 'services', 'configmaps', 'events', 'persistentvolumeclaims'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'replicasets'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: ['networking.k8s.io'],
        resources: ['networkpolicies'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: ['gateway.networking.k8s.io'],
        resources: ['httproutes'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ],
  },
};

class RbacTemplateHelper {
  list() {
    return Object.entries(TEMPLATES).map(([name, tpl]) => ({ name, description: tpl.description }));
  }

  getRules(templateName) {
    const tpl = TEMPLATES[templateName];
    if (!tpl) {
      throw new Error(`알 수 없는 RBAC 템플릿: ${templateName} (사용 가능: ${Object.keys(TEMPLATES).join(', ')})`);
    }
    return tpl.rules;
  }
}

module.exports = new RbacTemplateHelper();
