'use strict';

const express = require('express');
const k8sAdminService = require('../../services/k8sAdminService.cjs');
const rbacTemplateHelper = require('../../helpers/rbacTemplateHelper.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');

const router = express.Router();
router.use(authMiddlewareHelper.requireAdmin());

router.get('/rbac-templates', (req, res) => {
  res.json(rbacTemplateHelper.list());
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
    const result = await k8sAdminService.issueDeveloperAccount({
      namespace,
      name,
      rbacTemplate,
      issuedBy: req.admin.sub,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/:namespace/:name', async (req, res, next) => {
  try {
    await k8sAdminService.revokeDeveloperAccount({ namespace: req.params.namespace, name: req.params.name });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
