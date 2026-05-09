pbcopy() {
  local has_pb has_osc
  [[ -x /usr/bin/pbcopy ]] && has_pb=1
  command -v osc &>/dev/null && has_osc=1
  if [[ $has_pb && $has_osc ]]; then
    tee >(/usr/bin/pbcopy >/dev/null) | osc copy
  elif [[ $has_pb ]]; then
    /usr/bin/pbcopy
  elif [[ $has_osc ]]; then
    osc copy
  fi
}
