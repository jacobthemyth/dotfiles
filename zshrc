# load custom executable functions
for function in ~/.zsh/functions/*; do
  source $function
done

# makes color constants available
autoload -U colors
colors

# enable colored output from ls, etc. on FreeBSD-based systems
export CLICOLOR=1

# Base16 Shell
BASE16_SHELL="$HOME/.base16-manager/chriskempson/base16-shell"
[ -n "$PS1" ] && [ -s "$BASE16_SHELL/profile_helper.sh" ] && eval "$("$BASE16_SHELL/profile_helper.sh")"

unsetopt cdablevars

# Show description in completion menu
zstyle ":completion:*:descriptions" format "%B%d%b"

[ -f $HOME/.config/digitalocean ] && source $HOME/.config/digitalocean
[ -f $HOME/.config/homebrew ] && source $HOME/.config/homebrew

export PATH="/usr/local/bin:$PATH"
export PATH="$HOME/.bin:$PATH"
export PATH=".git/safe/../../bin:$PATH"
export PATH="node_modules/.bin:$PATH"
export PATH="/usr/local/opt/vertica/bin:$PATH"
export PATH="/usr/local/opt/postgresql@9.4/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$(brew --prefix qt@5.5)/bin:$PATH"
export PATH=$(go env GOPATH)/bin:$PATH
export PATH="$HOME/.cargo/bin:$PATH"

export ANDROID_HOME=${HOME}/Library/Android/sdk
export PATH=${PATH}:${ANDROID_HOME}/tools
export PATH=${PATH}:${ANDROID_HOME}/platform-tools

export FZF_DEFAULT_OPTS="--extended --cycle"

export POWERLEVEL9K_MODE='nerdfont-complete'

eval "$(rbenv init - --no-rehash)"
eval "$(nodenv init -)"

# Enable Ctrl-x-e to edit command line
autoload -U edit-command-line
zle -N edit-command-line
bindkey '^xe' edit-command-line
bindkey '^x^e' edit-command-line

export VISUAL=nvim
export EDITOR=$VISUAL

setopt hist_ignore_all_dups inc_append_history
HISTFILE=~/.zhistory
HISTSIZE=4096
SAVEHIST=4096

# vi mode
bindkey -v
bindkey "^F" vi-cmd-mode

# handy keybindings
bindkey "^A" beginning-of-line
bindkey "^E" end-of-line
bindkey "^K" kill-line
bindkey "^R" history-incremental-search-backward
bindkey "^P" history-search-backward
bindkey "^Y" accept-and-hold
bindkey "^N" insert-last-word
bindkey "^Q" push-line-or-edit
bindkey -s "^T" "^[Isudo ^[A" # "t" for "toughguy"

# awesome cd movements from zshkit
setopt autocd autopushd pushdminus pushdsilent pushdtohome cdablevars
DIRSTACKSIZE=5

# Enable extended globbing
setopt extendedglob

# Allow [ or ] whereever you want
unsetopt nomatch

# modify the prompt to contain git branch name if applicable
git_prompt_info() {
  current_branch=$(git current-branch 2> /dev/null)
  if [[ -n $current_branch ]]; then
    echo " %{$fg_bold[green]%}$current_branch%{$reset_color%}"
  fi
}

setopt promptsubst

# Allow exported PS1 variable to override default prompt.
if ! env | grep -q '^PS1='; then
  PS1='${SSH_CONNECTION+"%{$fg_bold[green]%}%n@%m:"}%{$fg_bold[blue]%}%c%{$reset_color%}$(git_prompt_info) %# '
fi

# aliases
[[ -f ~/.aliases ]] && source ~/.aliases
