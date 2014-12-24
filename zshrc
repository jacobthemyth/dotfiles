source $HOME/.profile

ZSH_CUSTOM=$HOME/.zsh
ZSH=$HOME/.oh-my-zsh
ZSH_THEME="avit"

# Turn off control flow
stty -ixon -ixoff

# Vim
export VISUAL=vim
export EDITOR=$VISUAL

# Comment out following line if you don't want red dots to be displayed
# while waiting for completion
COMPLETION_WAITING_DOTS="true"

# Comment out following line if you want greedy autocomplete
setopt MENU_COMPLETE

# Show description in completion menu
zstyle ":completion:*:descriptions" format "%B%d%b"

ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets root)
plugins=(tm tmux vi-mode zsh-syntax-highlighting)
source $ZSH/oh-my-zsh.sh

if which rbenv > /dev/null; then eval "$(rbenv init -)"; fi
if which homework > /dev/null; then eval "$(homework setup -)"; fi

# makes color constants available
autoload -U colors
colors

# enable colored output from ls, etc
export CLICOLOR=1

# history settings
setopt hist_ignore_all_dups inc_append_history
HISTSIZE=4096
SAVEHIST=4096
unsetopt histverify # Don't verify history expansion, e.g. !!

# awesome cd movements from zshkit
setopt autocd autopushd pushdminus pushdsilent pushdtohome cdablevars
DIRSTACKSIZE=5

# Enable extended globbing
setopt extendedglob

# Disable globbing for commands that need special characters
alias rake="noglob rake"

# vi mode
bindkey -v

# backspace ,^h, ^u working even after returning from command mode
bindkey '^?' backward-delete-char
bindkey '^h' backward-delete-char
bindkey '^u' backward-kill-line

# ctrl-w removed word backwards
bindkey '^w' backward-kill-word

# ctrl-r starts searching history backward
bindkey '^R' history-incremental-search-backward

bindkey '^[[A' up-line-or-search
bindkey '^[[B' down-line-or-search

bindkey "^A" beginning-of-line
bindkey "^E" end-of-line

mkcd () {
    mkdir -p "$@" && cd "$@"
}

growl() {
  terminal-notifier -activate com.googlecode.iterm2 -title "Beep Boop Beep Boop" -message "$@"
  say -v "Ting-Ting" -r 275 "Beep Boop Beep Boop"
}

[[ -f ~/.aliases ]] && source ~/.aliases
