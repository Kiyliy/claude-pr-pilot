module.exports = {
  apps: [
    {
      name: "auto-reviewer",
      script: "main.ts",
      interpreter: "./node_modules/.bin/tsx",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: require("path").join(__dirname, "logs/error.log"),
      out_file: require("path").join(__dirname, "logs/out.log"),
      merge_logs: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 15000,
    },
  ],
};
