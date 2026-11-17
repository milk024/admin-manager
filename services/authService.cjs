'use strict';

const dbService = require('./dbService.cjs');
const passwordHelper = require('../helpers/passwordHelper.cjs');
const jwtHelper = require('../helpers/jwtHelper.cjs');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');

// 없는 계정으로 로그인할 때도 같은 bcrypt 비교를 하기 위한 더미 해시 (처음 쓸 때 한 번 생성)
let dummyHashPromise = null;
const dummyHash = () => (dummyHashPromise ||= passwordHelper.hash('timing-equalizer-not-a-real-password'));

class AuthService {
  // admin_users가 완전히 비어있을 때만 .env의 ADMIN_BOOTSTRAP_* 값으로 최초 계정을 만든다.
  // 이후 기동부터는 테이블에 이미 계정이 있으니 항상 스킵됨 — .env에 값이 남아있어도 안전.
  async bootstrapFirstAdminIfNeeded() {
    const { rows } = await dbService.query('SELECT COUNT(*)::int AS count FROM admin_users');
    if (rows[0].count > 0) return;

    if (!config.adminBootstrap.username || !config.adminBootstrap.password) {
      logHelper.warn('AuthService', 'admin_users가 비어있는데 ADMIN_BOOTSTRAP_USERNAME/PASSWORD도 없음 — 로그인 불가 상태');
      return;
    }

    const passwordHash = await passwordHelper.hash(config.adminBootstrap.password);
    await dbService.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
      [config.adminBootstrap.username, passwordHash],
    );
    logHelper.info('AuthService', `부트스트랩 관리자 계정 생성됨: ${config.adminBootstrap.username}`);
  }

  async login(username, password) {
    const { rows } = await dbService.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    const user = rows[0];
    // 계정이 없어도 bcrypt 비교 시간만큼 걸리게 해서 응답 시간으로 계정 존재 여부가 드러나지 않게 한다
    const valid = await passwordHelper.verify(password, user ? user.password_hash : await dummyHash());
    if (!user) {
      throw new Error('존재하지 않는 계정입니다');
    }
    if (!valid) {
      throw new Error('비밀번호가 올바르지 않습니다');
    }
    const token = jwtHelper.sign({ sub: user.username });
    return { token, username: user.username };
  }

  // 이미 인증된 관리자가 다른 관리자 계정을 추가할 때 사용 (라우터에서 requireAdmin 통과 후 호출).
  async createAdmin(username, password) {
    const passwordHash = await passwordHelper.hash(password);
    await dbService.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
      [username, passwordHash],
    );
  }
}

module.exports = new AuthService();
