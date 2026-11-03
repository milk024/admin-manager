'use strict';

// k8s_manager/helpers/logHelper.cjs와 동일 — 로그 수집 방식이 정해지면 이 클래스만 바꾸면 됨.
class LogHelper {
  _format(level, scope, message) {
    return `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;
  }

  info(scope, message) {
    console.log(this._format('INFO', scope, message));
  }

  warn(scope, message) {
    console.warn(this._format('WARN', scope, message));
  }

  error(scope, message) {
    console.error(this._format('ERROR', scope, message));
  }
}

module.exports = new LogHelper();
