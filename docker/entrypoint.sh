#!/bin/sh
# The image runs as the unprivileged `node` user (uid 1000, gid 1000). Before
# the server starts, check that it can write where it keeps things: the
# database's folder, the parts folder and the backups folder. A volume made
# while the image still ran as root is owned by root, and the server would
# otherwise fail later with an error that doesn't say why.
set -eu

uid=$(id -u)
gid=$(id -g)
failed=0

check() {
  what=$1
  dir=$2
  mkdir -p "$dir" 2>/dev/null || true
  probe="$dir/.cbld-write-check.$$"
  if [ -d "$dir" ] && (: > "$probe") 2>/dev/null; then
    rm -f "$probe"
    return 0
  fi
  owner=$(stat -c '%u:%g' "$dir" 2>/dev/null || echo 'missing')
  echo "cbld: ERROR: the $what folder $dir is not writable by uid $uid (gid $gid); it is owned by $owner." >&2
  failed=1
}

db_path=${DB_PATH:-./data/cbld.sqlite}
check database "$(dirname "$db_path")"
check parts "${PARTS_DIR:-./data/parts}"
check backups "${BACKUPS_DIR:-/backups}"

if [ "$failed" -ne 0 ]; then
  cat >&2 <<MSG
cbld: The server runs as uid $uid, gid $gid, and stops here rather than fail later.
cbld: If these volumes were made by an older image (which ran as root), give
cbld: them to that user once. With docker compose, from the folder with docker-compose.yml:
cbld:   docker compose run --rm --user root --entrypoint chown app -R $uid:$gid /data /parts /backups
cbld: With plain docker (volume names from: docker volume ls):
cbld:   docker run --rm -v <data volume>:/data -v <parts volume>:/parts -v <backups volume>:/backups \\
cbld:     alpine chown -R $uid:$gid /data /parts /backups
cbld: For host folders: sudo chown -R $uid:$gid <folder>
cbld: See "Volumes" in the README.
MSG
  exit 1
fi

exec "$@"
