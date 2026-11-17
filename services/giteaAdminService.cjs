'use strict';

const crypto = require('crypto');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');

// Gitea 사용자·팀 관리 (계정 gitea-mgmt-svc 의 토큰 GITEA_MGMT_TOKEN, site admin).
// 할 수 있는 것: 사용자 목록·생성·로그인 차단/해제·비밀번호 초기화, 팀 구성원 추가/제거.
// 일부러 하지 않는 것: 사용자 삭제, 팀·저장소 생성/삭제, 권한(팀 설정) 변경 — Gitea 화면에서 gitea_admin 으로 한다.
//
// 보호 대상 (어떤 작업도 거부):
//   - site admin 계정 (gitea_admin, gitea-mgmt-svc)
//   - 보호 팀의 구성원 (Owners, ci-*, svc-* → CI·서비스 계정)
//   - 보호 팀 자체의 구성원 추가/제거
// 이 판정은 매 요청마다 Gitea 현재 상태로 다시 한다 (캐시하지 않음).
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,38}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class GiteaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class GiteaAdminService {
  get enabled() {
    return Boolean(config.gitea.baseUrl && config.gitea.token);
  }

  async _api(method, path, body) {
    if (!this.enabled) throw new GiteaError(503, 'Gitea 관리 기능이 설정되지 않았습니다 (GITEA_BASE_URL / GITEA_MGMT_TOKEN)');
    let res;
    try {
      res = await fetch(`${config.gitea.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `token ${config.gitea.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new GiteaError(502, `Gitea 에 연결할 수 없습니다: ${err.message}`);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.message || `Gitea 요청 실패 (${res.status})`;
      // Gitea 의 4xx 는 그대로(입력 오류·중복 등), 5xx·인증 오류는 502 로 바꿔 관리자 토큰 문제와 구분
      const code = [400, 404, 409, 422].includes(res.status) ? res.status : 502;
      throw new GiteaError(code, `Gitea: ${msg}`);
    }
    return data;
  }

  async _paged(path) {
    const out = [];
    for (let page = 1; page <= 50; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await this._api('GET', `${path}${sep}limit=50&page=${page}`);
      out.push(...items);
      if (items.length < 50) break;
    }
    return out;
  }

  _isProtectedTeam(name) {
    return config.gitea.protectedTeams.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  }

  // 팀 목록 + 구성원. 사용자·팀 화면과 보호 판정에 같이 쓴다.
  async _teamsWithMembers() {
    const teams = await this._paged(`/orgs/${encodeURIComponent(config.gitea.org)}/teams`);
    return Promise.all(teams.map(async (t) => {
      const members = await this._paged(`/teams/${t.id}/members`);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        permission: t.permission,
        protected: this._isProtectedTeam(t.name),
        members: members.map((m) => m.login),
      };
    }));
  }

  _protectionReason(user, teams) {
    if (user.is_admin) return 'site admin';
    const t = teams.find((team) => team.protected && team.members.includes(user.login));
    return t ? `보호 팀(${t.name}) 구성원` : null;
  }

  async _getUserChecked(username) {
    const [user, teams] = await Promise.all([
      this._api('GET', `/users/${encodeURIComponent(username)}`),
      this._teamsWithMembers(),
    ]);
    const reason = this._protectionReason(user, teams);
    if (reason) throw new GiteaError(403, `${username} 은(는) 보호 계정이라 여기서 변경할 수 없습니다 (${reason})`);
    return { user, teams };
  }

  _tempPassword() {
    // 영문 대소문자+숫자 20자. Gitea 기본 비밀번호 규칙(최소 길이)을 넉넉히 넘긴다
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(20);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  async listUsers() {
    const [users, teams] = await Promise.all([this._paged('/admin/users'), this._teamsWithMembers()]);
    return users
      .sort((a, b) => a.id - b.id)
      .map((u) => ({
        id: u.id,
        username: u.login,
        fullName: u.full_name,
        email: u.email,
        isAdmin: u.is_admin,
        prohibitLogin: u.prohibit_login,
        active: u.active,
        lastLogin: u.last_login && !u.last_login.startsWith('0001') ? u.last_login : null,
        created: u.created,
        teams: teams.filter((t) => t.members.includes(u.login)).map((t) => t.name),
        protected: this._protectionReason(u, teams),
      }));
  }

  async listTeams() {
    return this._teamsWithMembers();
  }

  // ── 변경 ────────────────────────────────────────────────────────────────

  async createUser({ username, email, fullName, teams: teamNames = [] }) {
    if (!USERNAME_RE.test(username || '')) throw new GiteaError(400, '아이디는 영문·숫자로 시작하고 영문·숫자·_.- 만, 39자 이하입니다');
    if (!EMAIL_RE.test(email || '')) throw new GiteaError(400, '이메일 형식이 올바르지 않습니다');

    const teams = await this._teamsWithMembers();
    const targets = teamNames.map((name) => {
      const t = teams.find((team) => team.name === name);
      if (!t) throw new GiteaError(400, `없는 팀입니다: ${name}`);
      if (t.protected) throw new GiteaError(403, `보호 팀(${name})에는 여기서 구성원을 추가할 수 없습니다`);
      return t;
    });

    const password = this._tempPassword();
    await this._api('POST', '/admin/users', {
      username,
      email,
      full_name: fullName || '',
      password,
      must_change_password: true,
      send_notify: false,
      visibility: 'private',
    });

    const added = [];
    const failed = [];
    for (const t of targets) {
      try {
        await this._api('PUT', `/teams/${t.id}/members/${encodeURIComponent(username)}`);
        added.push(t.name);
      } catch (err) {
        failed.push({ team: t.name, error: err.message });
      }
    }
    logHelper.info('GiteaAdminService', `사용자 생성: ${username} (팀: ${added.join(',') || '-'})`);
    // 임시 비밀번호는 이 응답으로 한 번만 돌려준다. 저장·로그·이력에 남기지 않는다.
    return { username, temporaryPassword: password, mustChangePassword: true, teams: added, failedTeams: failed };
  }

  async _editUser(user, patch) {
    // Gitea EditUserOption 은 login_name·source_id 를 요구한다 → 현재 값을 그대로 넘긴다
    return this._api('PATCH', `/admin/users/${encodeURIComponent(user.login)}`, {
      login_name: user.login_name || user.login,
      source_id: user.source_id ?? 0,
      ...patch,
    });
  }

  async setLoginProhibited(username, prohibited) {
    const { user } = await this._getUserChecked(username);
    await this._editUser(user, { prohibit_login: Boolean(prohibited) });
    logHelper.info('GiteaAdminService', `로그인 ${prohibited ? '차단' : '허용'}: ${username}`);
    return { username, prohibitLogin: Boolean(prohibited) };
  }

  async resetPassword(username, { mustChange = true } = {}) {
    const { user } = await this._getUserChecked(username);
    const password = this._tempPassword();
    await this._editUser(user, { password, must_change_password: Boolean(mustChange) });
    logHelper.info('GiteaAdminService', `비밀번호 초기화: ${username} (변경 강제: ${Boolean(mustChange)})`);
    return { username, temporaryPassword: password, mustChangePassword: Boolean(mustChange) };
  }

  async _teamChecked(teamName, username) {
    const { teams } = await this._getUserChecked(username);
    const t = teams.find((team) => team.name === teamName);
    if (!t) throw new GiteaError(404, `없는 팀입니다: ${teamName}`);
    if (t.protected) throw new GiteaError(403, `보호 팀(${teamName})의 구성원은 여기서 바꿀 수 없습니다`);
    return t;
  }

  async addTeamMember(teamName, username) {
    const t = await this._teamChecked(teamName, username);
    await this._api('PUT', `/teams/${t.id}/members/${encodeURIComponent(username)}`);
    logHelper.info('GiteaAdminService', `팀 구성원 추가: ${teamName} += ${username}`);
    return { team: teamName, username };
  }

  async removeTeamMember(teamName, username) {
    const t = await this._teamChecked(teamName, username);
    if (!t.members.includes(username)) throw new GiteaError(404, `${username} 은(는) ${teamName} 구성원이 아닙니다`);
    await this._api('DELETE', `/teams/${t.id}/members/${encodeURIComponent(username)}`);
    logHelper.info('GiteaAdminService', `팀 구성원 제거: ${teamName} -= ${username}`);
    return { team: teamName, username };
  }
}

module.exports = new GiteaAdminService();
