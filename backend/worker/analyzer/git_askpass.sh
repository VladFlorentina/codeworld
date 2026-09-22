#!/bin/sh
case "$1" in
  *sername*) echo "${CODEWORLD_GIT_USERNAME:-x-access-token}" ;;
  *assword*) echo "${CODEWORLD_GIT_PASSWORD}" ;;
esac
