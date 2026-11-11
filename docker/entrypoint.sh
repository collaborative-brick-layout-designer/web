#!/bin/sh
# The image runs as the unprivileged `node` user (uid 1000, gid 1000) unless
# started with another uid:gid (`--user 99:100`; no passwd entry needed).
# Before the server starts, check that whoever it runs as can write where it
# keeps things: the database's folder, the parts folder and the backups
# folder, each by a real write probe. A volume made while the image still
# ran as root is owned by root, and the server would otherwise fail later
# with an error that doesn't say why. The database's own files are checked
# too (cbld.sqlite and its -wal and -shm, when they exist): a file copied in
# as another user can sit unwritable in a folder that is writable, and the
# server would start and then fail on its first write. The uid and gid come from the running
# process (id -u, id -g), never from a fixed number, so the chown the
# message gives is the right one for this container.
set -eu

uid=$(id -u)
gid=$(id -g)
failed=0
echo "cbld: running as uid $uid, gid $gid (HOME=${HOME:-unset}, TMPDIR=${TMPDIR:-/tmp})" >&2

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

# A file that exists must open for writing (opened for appending, nothing
# written: its contents and its date stay as they are). A missing file is fine.
check_file() {
  file=$1
  [ -e "$file" ] || return 0
  if [ -f "$file" ] && (: >> "$file") 2>/dev/null; then
    return 0
  fi
  owner=$(stat -c '%u:%g' "$file" 2>/dev/null || echo 'unknown')
  mode=$(stat -c '%a' "$file" 2>/dev/null || echo '?')
  echo "cbld: ERROR: the database file $file is not writable by uid $uid (gid $gid); it is owned by $owner (mode $mode)." >&2
  failed=1
}

db_path=${DB_PATH:-./data/cbld.sqlite}
check database "$(dirname "$db_path")"
check_file "$db_path"
check_file "$db_path-wal"
check_file "$db_path-shm"
check parts "${PARTS_DIR:-./data/parts}"
check backups "${BACKUPS_DIR:-/backups}"

if [ "$failed" -ne 0 ]; then
  cat >&2 <<MSG
cbld: The server runs as uid $uid, gid $gid, and stops here rather than fail later.
cbld: If these volumes were made by an older image (which ran as root), or you
cbld: started the container as another user, give them to uid $uid, gid $gid once.
cbld: With docker compose, from the folder with docker-compose.yml:
cbld:   docker compose run --rm --user root --entrypoint chown app -R $uid:$gid /data /parts /backups
cbld: With plain docker (volume names from: docker volume ls):
cbld:   docker run --rm -v <data volume>:/data -v <parts volume>:/parts -v <backups volume>:/backups \\
cbld:     alpine chown -R $uid:$gid /data /parts /backups
cbld: For host folders: sudo chown -R $uid:$gid <folder>
cbld: (-R matters: it covers a database file restored or copied in as another user.)
cbld: See "Volumes" in the README.
MSG
  exit 1
fi

exec "$@"
