export PATH="$HOME/.cargo/bin:$PATH"

[[ -f ~/.zshenv.local ]] && source ~/.zshenv.local

export DO_NOT_TRACK=1

if [[ "$(arch)" == "arm64" ]]; then
  brew_path="/opt/homebrew/bin/brew"
else
  brew_path="/usr/local/bin/brew"
fi

eval "$("$brew_path" shellenv)"
