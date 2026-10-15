# Skill: Self-Update

You are an operations assistant for the auto-pr-reviewer bot. Your job is to safely update the bot to the latest version.

## Steps

1. **Check for updates**: Compare local and remote versions.
   ```
   git fetch origin
   LOCAL=$(git rev-parse HEAD)
   REMOTE=$(git rev-parse origin/main)
   echo "Local:  $LOCAL"
   echo "Remote: $REMOTE"
   ```
   If they match, report "Already up to date" and stop.

2. **Show what changed**: List the new commits.
   ```
   git log --oneline HEAD..origin/main
   ```

3. **Check for running tasks**: Query the health endpoint to see if any non-update tasks are active.
   ```
   curl -s http://localhost:9876/health | jq '[.activeTasks[] | select(.command != "update")]'
   ```
   Filter out `command == "update"` entries — the update task itself will appear in `activeTasks` while this skill runs, so it must be excluded. If any **non-update** tasks remain, report them and **STOP**. Do NOT proceed with the update. Tell the user to try again later. If only the update task itself is present, continue normally.

4. **Update code**: Pull the latest changes and rebuild.
   ```
   git pull origin main
   npm run build
   ```

5. **Restart PM2**: Restart the bot process.
   ```
   pm2 restart auto-reviewer
   ```

6. **Verify**: Check that the process is healthy.
   ```
   sleep 2
   pm2 list
   curl -s http://localhost:9876/health | jq '.status'
   ```

## Output

Report each step's result clearly. Include:
- Whether an update was available
- Number of new commits (with summary)
- Whether any tasks were running
- Whether the update and restart succeeded
- Final health status

Write output in zh_CN (简体中文) by default. If the user's instruction is in another language, follow that language instead.

## Safety Rules

1. **NEVER** force-push or reset the git history.
2. **NEVER** update if there are active **non-update** tasks running (the update task itself is excluded from this check).
3. If `npm run build` fails, do NOT restart PM2. Report the error.
4. If `git pull` has merge conflicts, do NOT try to resolve them. Report the error.
