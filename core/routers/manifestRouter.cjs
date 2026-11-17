'use strict';

const express = require('express');
const k8sAdminService = require('../../services/k8sAdminService.cjs');
const auditService = require('../../services/auditService.cjs');
const manifestWhitelistHelper = require('../../helpers/manifestWhitelistHelper.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');

const router = express.Router();
router.use(authMiddlewareHelper.requireAdmin());

router.get('/kinds', (req, res) => {
  res.json(manifestWhitelistHelper.list());
});

router.get('/history', async (req, res, next) => {
  try {
    res.json(await k8sAdminService.listManifestHistory(req.query.namespace));
  } catch (err) {
    next(err);
  }
});

// ns별 화면: 특정 Kind의 목록 (예: /api/manifests?namespace=rag-system&kind=Deployment)
router.get('/', async (req, res, next) => {
  try {
    const { namespace, kind } = req.query;
    if (!namespace || !kind) {
      return res.status(400).json({ error: 'namespace, kind 쿼리 파라미터가 필요합니다' });
    }
    res.json(await k8sAdminService.listManifestsByKind(namespace, kind));
  } catch (err) {
    next(err);
  }
});

// 단건 조회 — 수정 화면에 원본을 채워넣을 때 사용
router.get('/one', async (req, res, next) => {
  try {
    const { namespace, kind, name } = req.query;
    if (!namespace || !kind || !name) {
      return res.status(400).json({ error: 'namespace, kind, name 쿼리 파라미터가 필요합니다' });
    }
    res.json(await k8sAdminService.getManifest({ namespace, kind, name }));
  } catch (err) {
    next(err);
  }
});

// Pod 기준 화면: 이 Pod를 만든 Deployment + 물고 있는 ConfigMap/PVC/Secret(이름만) 묶어서 반환
router.get('/by-pod', async (req, res, next) => {
  try {
    const { namespace, pod } = req.query;
    if (!namespace || !pod) {
      return res.status(400).json({ error: 'namespace, pod 쿼리 파라미터가 필요합니다' });
    }
    res.json(await k8sAdminService.getPodRelatedResources(namespace, pod));
  } catch (err) {
    next(err);
  }
});

// 생성/수정 겸용 — 있으면 patch, 없으면 create (upsert). k8s_manager의 upsertNetworkPolicy와
// 같은 패턴.
router.put('/', async (req, res, next) => {
  try {
    const manifest = req.body;
    if (!manifest?.apiVersion || !manifest?.kind) {
      return res.status(400).json({ error: 'apiVersion, kind는 필수입니다' });
    }
    const target = `${manifest.metadata?.namespace}/${manifest.kind}/${manifest.metadata?.name}`;
    const result = await auditService.run(req, 'manifest.apply', target, null, () =>
      k8sAdminService.applyManifest(manifest, req.admin.sub));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const { apiVersion, kind, namespace, name } = req.query;
    if (!apiVersion || !kind || !namespace || !name) {
      return res.status(400).json({ error: 'apiVersion, kind, namespace, name 쿼리 파라미터가 모두 필요합니다' });
    }
    const result = await auditService.run(req, 'manifest.delete', `${namespace}/${kind}/${name}`, null, () =>
      k8sAdminService.deleteManifest({ apiVersion, kind, namespace, name }, req.admin.sub));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
