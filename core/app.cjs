'use strict';

const express = require('express');
const cors = require('cors');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');
const authRouter = require('./routers/authRouter.cjs');
const accountRouter = require('./routers/accountRouter.cjs');
const manifestRouter = require('./routers/manifestRouter.cjs');
const auditRouter = require('./routers/auditRouter.cjs');
const giteaAdminRouter = require('./routers/giteaAdminRouter.cjs');

class App {
  constructor() {
    this.instance = express();
    this._registerMiddleware();
    this._registerRoutes();
    this._registerErrorHandler();
  }

  _registerMiddleware() {
    // Gateway(envoy) 뒤에서 실제 접속 IP 를 X-Forwarded-For 로 받는다 (로그인 시도 제한이 IP 기준).
    // 클러스터 내부 사설 대역에서 온 프록시만 신뢰한다.
    this.instance.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
    // k8s_manager와 같은 monitoring-web 프론트 하나가 이 서버도 같이 호출하므로
    // ALLOWED_ORIGINS 화이트리스트를 동일하게 사용한다.
    this.instance.use(cors({
      origin: config.allowedOrigins.length ? config.allowedOrigins : true,
      credentials: true,
    }));
    this.instance.use(express.json());
  }

  _registerRoutes() {
    this.instance.get('/api/health', (req, res) => res.json({ status: 'ok' }));

    this.instance.use('/api/auth', authRouter);
    this.instance.use('/api/accounts', accountRouter);
    this.instance.use('/api/manifests', manifestRouter);
    this.instance.use('/api/audit', auditRouter);
    this.instance.use('/api/gitea', giteaAdminRouter);
  }

  _registerErrorHandler() {
    // eslint-disable-next-line no-unused-vars
    this.instance.use((err, req, res, next) => {
      // K8s API 오류(권한 없음 403, 없음 404, 충돌 409 등)는 상태 코드를 그대로 돌려준다.
      // 나머지는 서버 오류(500).
      const k8sStatus = Number(err.code ?? err.statusCode ?? err.response?.statusCode);
      // 502/503 은 Gitea 연동 오류(giteaAdminService)
      const status = [400, 403, 404, 409, 422, 502, 503].includes(k8sStatus) ? k8sStatus : 500;
      if (status === 500) logHelper.error('App', err.stack || err.message);
      res.status(status).json({ error: k8sMessage(err) ?? err.message });
    });
  }
}

// K8s 클라이언트 오류는 message 에 HTTP 헤더까지 붙은 원문이 들어 있다 → body 의 message 만 꺼낸다
function k8sMessage(err) {
  let body = err.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return typeof body?.message === 'string' ? body.message : null;
}

module.exports = App;
