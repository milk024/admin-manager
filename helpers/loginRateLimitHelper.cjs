'use strict';

// 관리자 로그인 무차별 대입 방지 (외부 의존성 없는 메모리 방식 — replicas 1 기준).
// - (IP, 아이디) 조합: 15분 안에 5번 실패하면 15분 잠금
// - IP 하나: 15분 안에 20번 실패하면 15분 잠금 (아이디를 바꿔 가며 시도하는 경우)
// 성공하면 해당 (IP, 아이디) 실패 기록은 지운다. Pod 가 재시작되면 기록은 초기화된다.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;

class LoginRateLimitHelper {
  constructor() {
    this.failures = new Map(); // key -> [timestamps]
    setInterval(() => this._sweep(), WINDOW_MS).unref();
  }

  _recent(key, now) {
    const list = (this.failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length) this.failures.set(key, list); else this.failures.delete(key);
    return list;
  }

  // 잠겨 있으면 남은 초를, 아니면 0 을 돌려준다.
  retryAfterSeconds(ip, username) {
    const now = Date.now();
    const checks = [[`u:${ip}|${username}`, MAX_PER_USER], [`ip:${ip}`, MAX_PER_IP]];
    let wait = 0;
    for (const [key, max] of checks) {
      const list = this._recent(key, now);
      if (list.length >= max) wait = Math.max(wait, Math.ceil((list[0] + WINDOW_MS - now) / 1000));
    }
    return wait;
  }

  recordFailure(ip, username) {
    const now = Date.now();
    for (const key of [`u:${ip}|${username}`, `ip:${ip}`]) {
      this.failures.set(key, [...this._recent(key, now), now]);
    }
  }

  recordSuccess(ip, username) {
    this.failures.delete(`u:${ip}|${username}`);
  }

  _sweep() {
    const now = Date.now();
    for (const key of [...this.failures.keys()]) this._recent(key, now);
  }
}

module.exports = new LoginRateLimitHelper();
