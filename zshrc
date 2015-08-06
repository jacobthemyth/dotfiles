source $HOME/.profile

ZSH_CUSTOM=$HOME/.zsh
ZSH=$HOME/.oh-my-zsh
ZSH_THEME="jacobthemyth"

# COMPLETION SETTINGS
# add custom completion scripts
fpath=($ZSH_CUSTOM/completions $fpath)

# compsys initialization
autoload -U compinit
compinit

# Show description in completion menu
zstyle ":completion:*:descriptions" format "%B%d%b"

# Turn off control flow
stty -ixon -ixoff

# Vim
export VISUAL=vim
export EDITOR=$VISUAL

# Use emacs bindings in spite of EDITOR/VISUAL
bindkey -e

# Comment out following line if you don't want red dots to be displayed
# while waiting for completion
COMPLETION_WAITING_DOTS="true"

# Prevent zsh from changing tmux titles
DISABLE_AUTO_TITLE=true

# Comment out following line if you want greedy autocomplete
setopt MENU_COMPLETE

ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets root)
plugins=(git tm tmux zsh-syntax-highlighting)
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
alias git="noglob git"

_not_inside_tmux() { [[ -z "$TMUX" ]] }

ensure_tmux_is_running() {
  if _not_inside_tmux; then
    tat
  fi
}

ensure_tmux_is_running

[[ -f ~/.aliases ]] && source ~/.aliases
