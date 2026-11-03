'use strict';

const express = require('express');
const cors = require('cors');
const config = require('../helpers/configHelper.cjs');
const logHelper = require('../helpers/logHelper.cjs');
const authRouter = require('./routers/authRouter.cjs');
const accountRouter = require('./routers/accountRouter.cjs');
const manifestRouter = require('./routers/manifestRouter.cjs');

class App {
  constructor() {
    this.instance = express();
    this._registerMiddleware();
    this._registerRoutes();
    this._registerErrorHandler();
  }

  _registerMiddleware() {
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
  }

  _registerErrorHandler() {
    // eslint-disable-next-line no-unused-vars
    this.instance.use((err, req, res, next) => {
      logHelper.error('App', err.stack || err.message);
      res.status(500).json({ error: err.message });
    });
  }
}

module.exports = App;
