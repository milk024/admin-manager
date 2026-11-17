'use strict';

const express = require('express');
const k8sAdminService = require('../../services/k8sAdminService.cjs');
const auditService = require('../../services/auditService.cjs');
const rbacTemplateHelper = require('../../helpers/rbacTemplateHelper.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');
const config = require('../../helpers/configHelper.cjs');

// K8s 이름 규칙(DNS-1123 label). SA 이름 뒤에 -role/-binding 을 붙이므로 여유를 두고 50자까지
const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,48}[a-z0-9])?$/;

const router = express.Router();
router.use(authMiddlewareHelper.requireAdmin());

router.get('/rbac-templates', (req, res) => {
  res.json(rbacTemplateHelper.list());
});

// 발급 화면의 네임스페이스 선택지
router.get('/namespaces', (req, res) => {
  res.json(config.issuableNamespaces);
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await k8sAdminService.listIssuedAccounts(req.query.namespace));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { namespace, name, rbacTemplate } = req.body;
    if (!namespace || !name || !rbacTemplate) {
      return res.status(400).json({ error: 'namespace, name, rbacTemplate은 필수입니다' });
    }
    if (config.issuableNamespaces.length && !config.issuableNamespaces.includes(namespace)) {
      return res.status(400).json({ error: `발급할 수 없는 네임스페이스입니다: ${namespace} (가능: ${config.issuableNamespaces.join(', ')})` });
    }
    if (!NAME_RE.test(name)) {
      return res.status(400).json({ error: '이름은 영문 소문자·숫자·하이픈만, 50자 이하, 처음과 끝은 영문/숫자여야 합니다' });
    }
    const result = await auditService.run(req, 'account.issue', `${namespace}/${name}`, { rbacTemplate }, () =>
      k8sAdminService.issueDeveloperAccount({ namespace, name, rbacTemplate, issuedBy: req.admin.sub }));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/:namespace/:name', async (req, res, next) => {
  try {
    const { namespace, name } = req.params;
    await auditService.run(req, 'account.revoke', `${namespace}/${name}`, null, () =>
      k8sAdminService.revokeDeveloperAccount({ namespace, name, revokedBy: req.admin.sub }));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
