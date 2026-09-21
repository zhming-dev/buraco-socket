// pm2 supervisor for the socket server.
//
// The graceful deploy restart (docs/RESTART_RESILIENCE.md, `pm2 restart` or
// the dev console's "Restart (keep sessions)") ends with the process EXITING
// after its final all-rooms snapshot and relies on the supervisor to bring it
// back — an nohup/aaPanel-style launcher leaves it down.
//
// Start from the project directory so `cwd` (and therefore `.env`, loaded by
// src/config via dotenv) is the checkout:
//   pm2 start ecosystem.config.cjs && pm2 save
// Deploy: git pull && pm2 restart brazilia-socket
module.exports = {
  apps: [
    {
      name: 'brazilia-socket',
      script: 'src/index.js',
      // Restart, do not scale: the restart-hold path is single-node only
      // (DEPLOY_TOPOLOGY.md); a second instance needs REDIS_ADAPTER_ENABLED.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Must be >= RESTART_SNAPSHOT_TIMEOUT_MS (5 s) + the drain, so the final
      // snapshot is never cut off by a SIGKILL.
      kill_timeout: 15000,
      restart_delay: 1000,
      max_restarts: 30,
      // Everything else (PORT, REDIS_*, WEBHOOK_SECRET, RESTART_*) comes from
      // the checkout's .env.
      env: { NODE_ENV: 'production' },
      // Contabo (ws-buraco.wblue.id): the checkout and its Redis snapshots are
      // owned by `www`; keep the process on that account. Drop these two lines
      // on a host that runs pm2 as the app user already.
      uid: 'www',
      gid: 'www',
      merge_logs: true,
      time: true,
    },
  ],
};
