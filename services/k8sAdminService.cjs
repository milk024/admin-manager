'use strict';

const fs = require('fs');
const k8s = require('@kubernetes/client-node');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');
const rbacTemplateHelper = require('../helpers/rbacTemplateHelper.cjs');
const manifestWhitelistHelper = require('../helpers/manifestWhitelistHelper.cjs');
const dbService = require('./dbService.cjs');

// TokenRequest로 발급하는 토큰의 기본 만료 기간. 옛날 방식(ServiceAccount Secret에 영구 토큰이
// 자동으로 딸려오던 것)과 달리 TokenRequest 토큰은 반드시 만료된다 — 보안상 더 안전하지만,
// 발급한 kubeconfig가 이 기간 이후엔 못 쓰게 된다는 뜻이다. 갱신 기능은 이번 스캐폴딩 범위 밖.
const TOKEN_EXPIRATION_SECONDS = 60 * 60 * 24 * 365; // 1년

class K8sAdminService {
  constructor() {
    this.kubeConfig = new k8s.KubeConfig();
    this._loadKubeConfig();

    this.coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.rbacApi = this.kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
    this.appsApi = this.kubeConfig.makeApiClient(k8s.AppsV1Api);
    // Deployment/Service/ConfigMap/NetworkPolicy/HTTPRoute처럼 서로 다른 apiGroup을 가진
    // 리소스를 하나의 API로 다루기 위해 동적 클라이언트를 쓴다 (manifestWhitelistHelper로
    // Kind를 먼저 제한한 다음 이걸로 실제 적용/삭제/조회).
    this.objectApi = k8s.KubernetesObjectApi.makeApiClient(this.kubeConfig);
  }

  // k8s_manager/services/k8sService.cjs와 동일 패턴.
  _loadKubeConfig() {
    const isInCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
    if (isInCluster) {
      this.kubeConfig.loadFromCluster();
      logHelper.info('K8sAdminService', 'in-cluster ServiceAccount 인증 사용');
      return;
    }
    if (fs.existsSync(config.kubeconfigPath) && fs.statSync(config.kubeconfigPath).size > 0) {
      this.kubeConfig.loadFromFile(config.kubeconfigPath);
      logHelper.info('K8sAdminService', `로컬 kubeconfig 폴백: ${config.kubeconfigPath}`);
    } else {
      logHelper.warn('K8sAdminService', `in-cluster 환경 아님 & kubeconfig(${config.kubeconfigPath}) 없음/비어있음 — K8s API 호출은 실패함`);
    }
  }

  // ── 개발자 계정(ServiceAccount) 발급 ──────────────────────────────────────

  async issueDeveloperAccount({ namespace, name, rbacTemplate, issuedBy }) {
    const rules = rbacTemplateHelper.getRules(rbacTemplate); // 존재하지 않는 템플릿이면 여기서 던짐

    await this.coreApi.createNamespacedServiceAccount({
      namespace,
      body: { metadata: { name, labels: { 'admin-manager/issued': 'true' } } },
    });

    const roleName = `${name}-role`;
    await this.rbacApi.createNamespacedRole({
      namespace,
      body: { metadata: { name: roleName }, rules },
    });

    await this.rbacApi.createNamespacedRoleBinding({
      namespace,
      body: {
        metadata: { name: `${name}-binding` },
        subjects: [{ kind: 'ServiceAccount', name, namespace }],
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: roleName },
      },
    });

    const kubeconfig = await this._buildKubeconfig(namespace, name);

    await dbService.query(
      `INSERT INTO account_issuances (namespace, service_account, rbac_template, issued_by)
       VALUES ($1, $2, $3, $4)`,
      [namespace, name, rbacTemplate, issuedBy],
    );

    logHelper.info('K8sAdminService', `개발자 계정 발급: ${namespace}/${name} (템플릿: ${rbacTemplate}, 발급자: ${issuedBy})`);
    return { namespace, name, rbacTemplate, kubeconfig };
  }

  async _buildKubeconfig(namespace, serviceAccountName) {
    const tokenRes = await this.coreApi.createNamespacedServiceAccountToken({
      namespace,
      name: serviceAccountName,
      body: { spec: { expirationSeconds: TOKEN_EXPIRATION_SECONDS } },
    });
    const token = tokenRes.status.token;

    const cluster = this.kubeConfig.getCurrentCluster();
    if (!cluster) {
      throw new Error('현재 KubeConfig에서 cluster 정보를 찾을 수 없습니다');
    }

    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      clusters: [{
        name: cluster.name,
        server: cluster.server,
        caData: cluster.caData,
        skipTLSVerify: cluster.skipTLSVerify,
      }],
      users: [{ name: serviceAccountName, token }],
      contexts: [{
        name: `${namespace}-${serviceAccountName}`,
        cluster: cluster.name,
        user: serviceAccountName,
        namespace,
      }],
      currentContext: `${namespace}-${serviceAccountName}`,
    });
    return kc.exportConfig();
  }

  async revokeDeveloperAccount({ namespace, name }) {
    await this.rbacApi.deleteNamespacedRoleBinding({ namespace, name: `${name}-binding` });
    await this.rbacApi.deleteNamespacedRole({ namespace, name: `${name}-role` });
    await this.coreApi.deleteNamespacedServiceAccount({ namespace, name });

    await dbService.query(
      `UPDATE account_issuances SET revoked_at = now()
       WHERE namespace = $1 AND service_account = $2 AND revoked_at IS NULL`,
      [namespace, name],
    );
    logHelper.info('K8sAdminService', `개발자 계정 회수: ${namespace}/${name}`);
  }

  async listIssuedAccounts(namespace) {
    if (namespace) {
      const { rows } = await dbService.query(
        'SELECT * FROM account_issuances WHERE namespace = $1 ORDER BY issued_at DESC',
        [namespace],
      );
      return rows;
    }
    const { rows } = await dbService.query('SELECT * FROM account_issuances ORDER BY issued_at DESC');
    return rows;
  }

  // ── 네임스페이스 전체 YAML 관리 (Kind 화이트리스트 적용) ──────────────────────

  // 주의: objectApi.patch()는 기본이 StrategicMergePatch인데, 이건 core/apps 그룹
  // 리소스(Deployment/Service/ConfigMap/PVC)엔 잘 맞지만 HTTPRoute처럼 CRD인 리소스는
  // 보통 StrategicMergePatch를 지원하지 않고 MergePatch/JSON Patch만 지원한다.
  // HTTPRoute를 실제로 수정해보고 안 되면 patch(manifest, ..., PatchStrategy.MergePatch)로
  // 바꿔야 할 수 있음 — npm install 검증 시점엔 실제 HTTPRoute patch까진 테스트 안 함
  // (라이브 Gateway 라우팅에 영향을 줄 수 있어 이번 검증 범위에서 제외).
  async applyManifest(manifest, appliedBy) {
    manifestWhitelistHelper.assertAllowed(manifest.kind);
    const namespace = manifest.metadata?.namespace;
    const name = manifest.metadata?.name;
    if (!namespace || !name) {
      throw new Error('manifest.metadata.namespace/name은 필수입니다');
    }

    let action;
    try {
      const current = await this.objectApi.read({
        apiVersion: manifest.apiVersion,
        kind: manifest.kind,
        metadata: { namespace, name },
      });
      // 편집기에서 열람 후 저장까지 시간차가 있을 수 있으므로, 그 사이 다른 관리자가
      // 먼저 바꿨다면(예전에 GET한 resourceVersion과 지금 다르면) 조용히 덮어쓰지 않고 에러.
      if (manifest.metadata?.resourceVersion && manifest.metadata.resourceVersion !== current.metadata.resourceVersion) {
        throw new Error('이 리소스는 조회 이후 다른 곳에서 변경되었습니다 — 새로고침 후 다시 시도하세요');
      }
      await this.objectApi.patch(manifest);
      action = 'update';
    } catch (err) {
      if (err.code !== 404) throw err;
      await this.objectApi.create(manifest);
      action = 'create';
    }

    await dbService.query(
      `INSERT INTO manifest_history (namespace, kind, name, action, applied_by, manifest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [namespace, manifest.kind, name, action, appliedBy, JSON.stringify(manifest)],
    );
    return { namespace, kind: manifest.kind, name, action };
  }

  async deleteManifest({ apiVersion, kind, namespace, name }, appliedBy) {
    manifestWhitelistHelper.assertAllowed(kind);
    await this.objectApi.delete({ apiVersion, kind, metadata: { namespace, name } });

    await dbService.query(
      `INSERT INTO manifest_history (namespace, kind, name, action, applied_by, manifest)
       VALUES ($1, $2, $3, 'delete', $4, NULL)`,
      [namespace, kind, name, appliedBy],
    );
    return { namespace, kind, name, action: 'delete' };
  }

  // 단건 조회 — 프론트 수정 화면(Monaco 등 코드 에디터)이 "지금 이 리소스가 어떻게 생겼는지"
  // 가져올 때 사용. status/managedFields 등 서버 전용 필드는 편집 대상이 아니므로 제거해서
  // 반환한다 — resourceVersion만 남겨서 낙관적 동시성 체크(아래 applyManifest)에 쓴다.
  async getManifest({ kind, namespace, name }) {
    manifestWhitelistHelper.assertAllowed(kind);
    const apiVersion = manifestWhitelistHelper.apiVersionFor(kind);
    const manifest = await this.objectApi.read({ apiVersion, kind, metadata: { namespace, name } });
    return this._sanitizeForEditing(manifest);
  }

  _sanitizeForEditing(manifest) {
    const { status, metadata, ...rest } = manifest;
    const { uid, creationTimestamp, generation, selfLink, managedFields, ...cleanMetadata } = metadata || {};
    return { ...rest, metadata: cleanMetadata };
  }

  // 네임스페이스 화면에서 "이 ns의 Deployment 목록" 같은 걸 보여줄 때 사용.
  async listManifestsByKind(namespace, kind) {
    manifestWhitelistHelper.assertAllowed(kind);
    const apiVersion = manifestWhitelistHelper.apiVersionFor(kind);
    // 주의: KubernetesObjectApi.list 시그니처는 클라이언트 버전마다 달라졌던 이력이 있다.
    // npm install 이후 실제 버전(@kubernetes/client-node 1.4.0) 기준으로 한 번 검증 필요.
    const res = await this.objectApi.list(apiVersion, kind, namespace);
    return res.items ?? res.body?.items ?? [];
  }

  // Pod 기준으로 관련 리소스를 묶어서 보여준다 — "이 Pod를 만든 Deployment는 뭐고,
  // 어떤 ConfigMap/PVC/Secret을 물고 있는지"를 한 번에 파악하기 위함.
  // Secret은 이름만 반환하고 내용은 절대 조회하지 않는다(관리 범위 밖, 헬퍼 주석 참고).
  async getPodRelatedResources(namespace, podName) {
    const pod = await this.coreApi.readNamespacedPod({ namespace, name: podName });

    let owningDeployment = null;
    const rsOwner = (pod.metadata.ownerReferences || []).find((ref) => ref.kind === 'ReplicaSet');
    if (rsOwner) {
      const replicaSet = await this.appsApi.readNamespacedReplicaSet({ namespace, name: rsOwner.name });
      const deploymentOwner = (replicaSet.metadata.ownerReferences || []).find((ref) => ref.kind === 'Deployment');
      if (deploymentOwner) {
        owningDeployment = { name: deploymentOwner.name };
      }
    }

    const configMapNames = new Set();
    const pvcNames = new Set();
    const secretNames = new Set(); // 이름만 — 조회/수정 대상 아님

    for (const volume of pod.spec.volumes || []) {
      if (volume.configMap?.name) configMapNames.add(volume.configMap.name);
      if (volume.persistentVolumeClaim?.claimName) pvcNames.add(volume.persistentVolumeClaim.claimName);
      if (volume.secret?.secretName) secretNames.add(volume.secret.secretName);
    }
    for (const container of pod.spec.containers || []) {
      for (const envFrom of container.envFrom || []) {
        if (envFrom.configMapRef?.name) configMapNames.add(envFrom.configMapRef.name);
        if (envFrom.secretRef?.name) secretNames.add(envFrom.secretRef.name);
      }
    }

    return {
      pod: { name: pod.metadata.name, namespace },
      deployment: owningDeployment,
      configMaps: Array.from(configMapNames),
      persistentVolumeClaims: Array.from(pvcNames),
      secrets: Array.from(secretNames), // 이름만, 내용 없음 — kubectl로 직접 관리
    };
  }

  async listManifestHistory(namespace) {
    if (namespace) {
      const { rows } = await dbService.query(
        'SELECT * FROM manifest_history WHERE namespace = $1 ORDER BY applied_at DESC LIMIT 200',
        [namespace],
      );
      return rows;
    }
    const { rows } = await dbService.query('SELECT * FROM manifest_history ORDER BY applied_at DESC LIMIT 200');
    return rows;
  }
}

module.exports = new K8sAdminService();
