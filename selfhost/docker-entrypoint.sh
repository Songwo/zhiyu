#!/bin/sh
# 以 root 启动时先把资料目录交给 node 用户（Docker 自动创建的挂载目录属于 root），再降权运行。
set -e
data="${ZHIYU_DATA:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data"
  if [ "$(stat -c %u "$data")" != "$(id -u node)" ]; then
    chown -R node:node "$data"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
