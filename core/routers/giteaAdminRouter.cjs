'use strict';

const express = require('express');
const giteaAdminService = require('../../services/giteaAdminService.cjs');
const auditService = require('../../services/auditService.cjs');
const authMiddlewareHelper = require('../../helpers/authMiddlewareHelper.cjs');

// Gitea 사용자·팀 관리. 변경은 모두 audit_log 에 gitea.* 로 남긴다 (임시 비밀번호는 남기지 않음).
const router = express.Router();
router.use(authMiddlewareHelper.requireAdmin());

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

router.get('/users', wrap(async (req, res) => {
  res.json(await giteaAdminService.listUsers());
}));

router.get('/teams', wrap(async (req, res) => {
  res.json(await giteaAdminService.listTeams());
}));

router.post('/users', wrap(async (req, res) => {
  const { username, email, fullName, teams } = req.body || {};
  if (teams !== undefined && !(Array.isArray(teams) && teams.every((t) => typeof t === 'string'))) {
    return res.status(400).json({ error: 'teams 는 팀 이름 배열입니다' });
  }
  const result = await auditService.run(req, 'gitea.user.create', username, { email, teams: teams || [] }, () =>
    giteaAdminService.createUser({ username, email, fullName, teams }));
  res.status(201).json(result);
}));

// 로그인 차단/허용 — body { prohibitLogin: true|false }
router.patch('/users/:username/login', wrap(async (req, res) => {
  const { prohibitLogin } = req.body || {};
  if (typeof prohibitLogin !== 'boolean') return res.status(400).json({ error: 'prohibitLogin(true/false)이 필요합니다' });
  const { username } = req.params;
  const action = prohibitLogin ? 'gitea.user.disable' : 'gitea.user.enable';
  res.json(await auditService.run(req, action, username, null, () =>
    giteaAdminService.setLoginProhibited(username, prohibitLogin)));
}));

// 비밀번호 초기화 — 임시 비밀번호를 응답으로 한 번만 돌려준다. body { mustChange?: boolean } (기본 true)
router.post('/users/:username/reset-password', wrap(async (req, res) => {
  const mustChange = req.body?.mustChange !== false;
  const { username } = req.params;
  res.json(await auditService.run(req, 'gitea.user.reset_password', username, { mustChange }, () =>
    giteaAdminService.resetPassword(username, { mustChange })));
}));

router.put('/teams/:team/members/:username', wrap(async (req, res) => {
  const { team, username } = req.params;
  res.json(await auditService.run(req, 'gitea.team.add_member', `${team}/${username}`, null, () =>
    giteaAdminService.addTeamMember(team, username)));
}));

router.delete('/teams/:team/members/:username', wrap(async (req, res) => {
  const { team, username } = req.params;
  res.json(await auditService.run(req, 'gitea.team.remove_member', `${team}/${username}`, null, () =>
    giteaAdminService.removeTeamMember(team, username)));
}));

module.exports = router;
