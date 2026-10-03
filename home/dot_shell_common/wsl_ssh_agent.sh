#!/bin/sh
# wsl2-ssh-agent defaults to the absolute path of Windows PowerShell.
initialize_wsl_ssh_agent() {
  if _wsl_ssh_agent_env=$("$1"); then
    eval "$_wsl_ssh_agent_env"
    unset _wsl_ssh_agent_env
  else
    unset _wsl_ssh_agent_env
    echo "wsl2-ssh-agent: could not start the Windows SSH Agent bridge" >&2
    return 1
  fi
}
