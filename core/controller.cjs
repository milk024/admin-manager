'use strict';

const dbService = require('../services/dbService.cjs');
const authService = require('../services/authService.cjs');
const logHelper = require('../helpers/logHelper.cjs');

class Controller {
  async checkDatabase() {
    try {
      await dbService.query('SELECT 1');
      return { name: 'postgres', ok: true };
    } catch (err) {
      return { name: 'postgres', ok: false, error: err.message };
    }
  }

  async runStartupChecks() {
    // DB가 없으면 이후 아무 것도 못 하므로(관리자 인증부터 불가) 스키마 초기화 + 부트스트랩을
    // 시작 체크 단계에서 먼저 수행한다.
    await dbService.init();
    await authService.bootstrapFirstAdminIfNeeded();

    const results = await Promise.all([this.checkDatabase()]);
    results.forEach((result) => {
      if (result.ok) {
        logHelper.info('startup', `${result.name}: OK`);
      } else {
        logHelper.warn('startup', `${result.name}: FAIL (${result.error})`);
      }
    });
    return results;
  }
}

module.exports = new Controller();
