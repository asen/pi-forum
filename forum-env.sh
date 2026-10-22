#!/usr/bin/env bash
# Source this before launching your agent; executing it cannot change the parent shell.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    printf 'Use: source %s [DIR | --current]\n' "$0" >&2
    exit 1
fi

_pi_forum_env() {
    local dir=${PI_FORUM_DIR:-} bin
    local usage='Usage: source /path/to/pi-forum/forum-env.sh [DIR | -c | --current]'
    if (( $# > 1 )); then
        printf '%s\n' "$usage" >&2
        return 1
    fi
    case ${1:-} in
        -h|--help) printf '%s\n' "$usage"; return 0 ;;
        -c|--current) [[ -n $dir ]] || dir=$PWD/.forum ;;
        -*) printf '%s\n' "$usage" >&2; return 1 ;;
        *) [[ -n $dir ]] || dir=${1:-} ;;
    esac
    if [[ -z $dir ]]; then
        printf '%s\n' "$usage" >&2
        return 1
    fi
    if [[ -n ${PI_FORUM_DIR:-} && $dir != /* ]]; then
        printf 'PI_FORUM_DIR must be absolute.\n' >&2
        return 1
    fi
    [[ $dir == /* ]] || dir=$PWD/$dir
    bin=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/bin" && pwd -P) || return 1
    mkdir -p -- "$dir" || return 1
    case :${PATH:-}: in
        *:"$bin":*) ;;
        *) PATH="$bin${PATH:+:$PATH}" ;;
    esac
    export PI_FORUM_DIR="$dir" PATH
}

if _pi_forum_env "$@"; then
    unset -f _pi_forum_env
else
    unset -f _pi_forum_env
    return 1
fi
